// src/llm/http.ts
//
// One JSON POST helper shared by both adapters. Same hand-rolled-fetch style as
// qdrant.ts and integrations/*.ts -- no provider SDK, which is what lets the two
// adapters set provider-specific body fields (`plugins`, `search_parameters`,
// `web_search_options`) without fighting a typed client.
//
// Retries only what is worth retrying: 429 and 5xx, plus network errors. A 400 from
// a bad model id or a malformed tool schema is returned immediately -- retrying it
// just delays a failure the operator needs to see.

import { LlmError } from "./types.js";

const MAX_ATTEMPTS = Number(process.env.AGENT_LLM_MAX_ATTEMPTS ?? 4);
const BASE_BACKOFF_MS = 1000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Honours a numeric `Retry-After` (seconds) when the provider sends one. */
function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  }
  return BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

export async function postJson<T>(opts: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  /** Used only in error messages, so a failure says which provider produced it. */
  label: string;
}): Promise<T> {
  let lastError: LlmError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) throw new Error("Aborted");

    let res: Response;
    try {
      res = await fetch(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        body: JSON.stringify(opts.body),
        signal: opts.signal,
      });
    } catch (err) {
      // An abort is the operator stopping an act phase, not a transient fault -- don't retry it.
      if (opts.signal?.aborted) throw err;
      lastError = new LlmError(`${opts.label}: network error: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(retryDelayMs(new Response(null), attempt), opts.signal);
      continue;
    }

    if (res.ok) return (await res.json()) as T;

    const text = await res.text().catch(() => "");
    const error = new LlmError(`${opts.label}: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 800)}`, res.status, text);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) throw error;

    lastError = error;
    console.warn(`[llm] ${opts.label} attempt ${attempt}/${MAX_ATTEMPTS} failed (${res.status}); retrying`);
    await sleep(retryDelayMs(res, attempt), opts.signal);
  }

  throw lastError ?? new LlmError(`${opts.label}: request failed`);
}
