// src/tools/web.ts
//
// WebSearch and WebFetch. Both were Claude Code built-ins and both disappeared with
// the Agent SDK, so this file is their replacement -- and unlike the originals they
// work identically whichever provider is driving the loop.
//
// WebFetch is always registered. WebSearch is registered only when the operator's
// search mode is an HTTP provider (tavily/brave); in "native" mode the model's own
// provider does the searching and there is no local tool to register, and in "none"
// mode there is no search at all. Either way "WebSearch" stays a valid entry in a
// proposal's required_tools -- agent-loop.ts reads the grant and turns on the
// provider's native search instead of a tool call.

import { z } from "zod";
import { getSearchConfig } from "../search/index.js";
import { defineTool, type ToolDefinition } from "./registry.js";

/** Fetched pages are truncated so one enormous page can't blow out the context window. */
const DEFAULT_FETCH_CHARS = Number(process.env.AGENT_WEBFETCH_MAX_CHARS ?? 20_000);
const FETCH_TIMEOUT_MS = Number(process.env.AGENT_WEBFETCH_TIMEOUT_MS ?? 20_000);
const USER_AGENT = process.env.AGENT_USER_AGENT ?? "ReflexLoop/1.0 (+autonomous research agent)";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Deliberately a regex pass rather than a DOM parser: the model only needs readable prose,
 * and a real parser would be a dependency (plus a per-fetch cost) for output it would
 * summarise into a research note anyway.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      // Whole elements whose text content is never prose.
      .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      // Block-level boundaries become line breaks so structure survives tag stripping.
      .replace(/<\/?(p|div|section|article|header|footer|tr|ul|ol|table|h[1-6]|blockquote|pre)\b[^>]*>/gi, "\n")
      .replace(/<br\b[^>]*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/**
 * Blocks a fetch from being pointed at the machine's own network. Exported because the
 * declarative connectors in src/connectors/ resolve their request URLs from a manifest
 * and need the same guarantee -- one check, not two that can drift.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https URLs can be fetched (got ${url.protocol}).`);
  }
  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal");
  if (isLoopback) {
    // The console, the SQLite file and any integration tokens all live on this host;
    // a research phase has no legitimate reason to reach them, and a page it read
    // could be what asked it to.
    throw new Error(`Refusing to fetch a private or loopback address (${url.hostname}).`);
  }
  return url;
}

async function fetchAsText(rawUrl: string, maxChars: number): Promise<string> {
  const url = assertPublicHttpUrl(rawUrl);
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const body = await res.text();
  const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body);
  const text = isHtml ? htmlToText(body) : body.trim();

  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters]`;
}

function formatResults(query: string, results: { title: string; url: string; snippet: string }[]): string {
  if (results.length === 0) return `No results for "${query}".`;
  return results
    .map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet.replace(/\s+/g, " ").trim()}`)
    .join("\n\n");
}

/**
 * WebFetch always; WebSearch only when an HTTP search provider is configured. The
 * caller adds these to the same registry as the memory and integration tools.
 */
export function buildWebTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    defineTool(
      "WebFetch",
      "Fetch a web page and return its readable text content. Use it to read a specific URL you already have -- from a search result, a research note, or a repo. Returns plain text with markup stripped, truncated if the page is very long.",
      {
        url: z.string().describe("Absolute http(s) URL to fetch"),
        maxChars: z
          .number()
          .int()
          .positive()
          .max(200_000)
          .optional()
          .describe("Cap on returned characters; defaults to a sensible limit"),
      },
      async ({ url, maxChars }) => {
        try {
          return await fetchAsText(url, maxChars ?? DEFAULT_FETCH_CHARS);
        } catch (err) {
          return { text: `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }
    ),
  ];

  const { provider } = getSearchConfig();
  if (provider) {
    tools.push(
      defineTool(
        "WebSearch",
        "Search the web and return ranked results with titles, URLs and snippets. Use it to find sources; follow up with WebFetch to read any result in full.",
        {
          query: z.string().describe("The search query"),
          limit: z.number().int().positive().max(20).optional().describe("Maximum results to return (default 8)"),
        },
        async ({ query, limit }) => {
          try {
            return formatResults(query, await provider.search(query, limit ?? 8));
          } catch (err) {
            return { text: `Error searching for "${query}": ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
        }
      )
    );
  }

  return tools;
}
