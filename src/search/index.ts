// src/search/index.ts
//
// Decides how WebSearch is actually performed, once, at startup.
//
// WebSearch was a Claude Code built-in; dropping the Agent SDK means this project
// has to answer the question itself. Three answers are supported, and the choice is
// invisible above this file -- "WebSearch" stays one grantable tool name in
// tool-catalog.ts, one badge in the console, and one entry in a proposal's
// required_tools, whichever mode is in force:
//
//   tavily / brave -- we call a search API and hand the model the results as an
//     ordinary tool result. Identical behaviour on all five providers.
//   native         -- we don't register a WebSearch tool at all; instead the model's
//     own provider runs the search server-side (agent-loop.ts sets ChatRequest.nativeSearch
//     when the phase was granted WebSearch). No extra key, but behaviour and quality
//     vary by provider, and OpenAI only honours it on its search-enabled models.
//   none           -- no web search at all. Research still has WebFetch and the
//     read-only integration tools.
//
// AGENT_SEARCH_PROVIDER selects; the default, "auto", picks the first that's usable:
// Tavily, then Brave, then native, then none.

import { createBraveProvider } from "./brave.js";
import { createTavilyProvider } from "./tavily.js";
import type { SearchProvider } from "./types.js";

export type { SearchProvider, SearchResult } from "./types.js";

export type SearchMode = "tavily" | "brave" | "native" | "none";

export interface SearchConfig {
  mode: SearchMode;
  /** Set for the tavily/brave modes only; null for native and none. */
  provider: SearchProvider | null;
}

let cached: SearchConfig | null = null;

function build(): SearchConfig {
  const tavilyKey = (process.env.TAVILY_API_KEY ?? "").trim();
  const braveKey = (process.env.BRAVE_API_KEY ?? "").trim();
  const requested = (process.env.AGENT_SEARCH_PROVIDER ?? "auto").trim().toLowerCase();

  const withTavily = (): SearchConfig => ({ mode: "tavily", provider: createTavilyProvider(tavilyKey) });
  const withBrave = (): SearchConfig => ({ mode: "brave", provider: createBraveProvider(braveKey) });

  switch (requested) {
    case "tavily":
      if (!tavilyKey) throw new Error("AGENT_SEARCH_PROVIDER=tavily requires TAVILY_API_KEY.");
      return withTavily();
    case "brave":
      if (!braveKey) throw new Error("AGENT_SEARCH_PROVIDER=brave requires BRAVE_API_KEY.");
      return withBrave();
    case "native":
      return { mode: "native", provider: null };
    case "none":
      return { mode: "none", provider: null };
    case "auto":
      if (tavilyKey) return withTavily();
      if (braveKey) return withBrave();
      return { mode: "native", provider: null };
    default:
      throw new Error(
        `AGENT_SEARCH_PROVIDER="${requested}" is not supported. Use one of: auto, tavily, brave, native, none.`
      );
  }
}

export function getSearchConfig(): SearchConfig {
  if (!cached) cached = build();
  return cached;
}

/** Test seam: forces the next getSearchConfig() to re-read the environment. */
export function resetSearchConfig(): void {
  cached = null;
}
