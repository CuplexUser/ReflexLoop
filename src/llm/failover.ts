// src/llm/failover.ts
//
// One phase's model, with up to two backups behind it.
//
// A provider failing used to cost the whole phase: `postJson` retries 429/5xx, but once those
// retries ran out -- or when OpenRouter answered 200 with `{"error": "Provider returned an empty
// response"}`, which nothing retried at all -- the error propagated out of `runAgent` and a
// 6-minute research cycle or a deep dive ended with nothing. The operator can now name fallback
// models (settings `fallback*`), and this client walks the chain: primary, then fallback 1, then
// fallback 2.
//
// **Per call, not per phase.** The transcript is in the neutral `ChatMessage` shape, so a
// different provider can pick up the very turn the primary failed on, with all the reading the
// phase already did still in context. Restarting the phase on the backup would throw that away.
//
// **Sticky for the rest of the phase.** Once a fallback has answered, later turns go to it
// directly rather than paying the primary's retry backoff again on every turn. A new phase gets
// a new FailoverClient (see `createPhaseClient`), so the next phase tries the primary first.
//
// **Everything except an abort fails over**, including a 400 or a 401/402. A bad model id on the
// primary is a configuration mistake the operator should see, and they do -- every switch is
// logged and emitted to the console feed -- but out-of-credits on one account is precisely the
// outage a backup on another account exists for, and it arrives as a 4xx.
//
// `providerRaw` is tagged with the index of the client that produced it and replayed only to
// that client. The Anthropic adapter replays it in preference to `content`, and another model's
// raw blocks (thinking signatures included) are not something a different model can accept.

import { isAbortError } from "../aborted.js";
import { sleep } from "./http.js";
import type { ChatMessage, ChatRequest, ChatResponse, LlmClient, ProviderId, ToolCall } from "./types.js";
import { LlmError } from "./types.js";

/** Pause before retrying a transient in-body error on the same client. */
const TRANSIENT_RETRY_DELAY_MS = 2000;

export interface FailoverInfo {
  from: string;
  to: string;
  error: string;
}

interface TaggedRaw {
  servedBy: number;
  raw: unknown;
}

function isTagged(value: unknown): value is TaggedRaw {
  return typeof value === "object" && value !== null && "servedBy" in value && "raw" in value;
}

export function describeClient(client: LlmClient): string {
  return `${client.provider}/${client.model}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class FailoverClient implements LlmClient {
  private active = 0;

  constructor(
    private readonly chain: LlmClient[],
    private readonly onFailover?: (info: FailoverInfo) => void
  ) {
    if (chain.length === 0) throw new Error("FailoverClient needs at least one client.");
  }

  private get current(): LlmClient {
    return this.chain[this.active];
  }

  // Getters, not fields: agent-loop prices each turn off `provider`/`model` right after the call
  // returns, so these have to name whichever client actually served it.
  get provider(): ProviderId {
    return this.current.provider;
  }

  get model(): string {
    return this.current.model;
  }

  get supportsNativeSearch(): boolean {
    return this.current.supportsNativeSearch;
  }

  handleNativeToolCall(call: ToolCall): string | null {
    return this.current.handleNativeToolCall(call);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const failures: string[] = [];

    for (let index = this.active; index < this.chain.length; index++) {
      const client = this.chain[index];
      const request = { ...req, messages: messagesFor(req.messages, index) };

      // A transient error (a 200 carrying an error, no choices) gets one more try on the same
      // client: postJson already retried the HTTP-level failures, but never saw these.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await client.chat(request);
          if (index !== this.active) {
            const info = { from: describeClient(this.current), to: describeClient(client), error: failures.at(-1) ?? "" };
            console.warn(`[llm] failing over from ${info.from} to ${info.to}: ${info.error}`);
            this.active = index;
            this.onFailover?.(info);
          }
          return {
            ...response,
            providerRaw: response.providerRaw === undefined ? undefined : { servedBy: index, raw: response.providerRaw },
          };
        } catch (err) {
          if (isAbortError(err) || req.signal?.aborted) throw err;
          const transient = err instanceof LlmError && err.transient;
          if (transient && attempt === 1) {
            console.warn(`[llm] ${describeClient(client)}: ${errorText(err)}; retrying once`);
            await sleep(TRANSIENT_RETRY_DELAY_MS, req.signal);
            continue;
          }
          failures.push(`${describeClient(client)}: ${errorText(err)}`);
          break;
        }
      }
    }

    if (failures.length === 1) throw new LlmError(failures[0]);
    throw new LlmError(`All ${failures.length} models failed. ${failures.join(" | ")}`);
  }
}

/** The history as client `index` should see it: its own raw turns kept, everyone else's dropped. */
function messagesFor(messages: ChatMessage[], index: number): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || message.providerRaw === undefined) return message;
    const raw = message.providerRaw;
    const ownRaw = isTagged(raw) && raw.servedBy === index ? raw.raw : undefined;
    return { ...message, providerRaw: ownRaw };
  });
}
