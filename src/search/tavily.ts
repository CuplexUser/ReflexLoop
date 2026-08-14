// src/search/tavily.ts
//
// Tavily is built for agents rather than for humans reading a results page: each hit
// comes back as a summarized passage, so the research phase can often answer from the
// search results alone instead of spending a WebFetch on every link.

import type { SearchProvider, SearchResult } from "./types.js";

const ENDPOINT = "https://api.tavily.com/search";

interface TavilyResponse {
  results?: { title?: string; url?: string; content?: string }[];
}

export function createTavilyProvider(apiKey: string): SearchProvider {
  return {
    name: "tavily",
    async search(query: string, limit: number): Promise<SearchResult[]> {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query,
          max_results: limit,
          search_depth: process.env.TAVILY_SEARCH_DEPTH ?? "basic",
          include_answer: false,
        }),
      });
      if (!res.ok) {
        throw new Error(`Tavily search failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
      }
      const json = (await res.json()) as TavilyResponse;
      return (json.results ?? [])
        .filter((hit) => hit.url)
        .map((hit) => ({ title: hit.title ?? hit.url!, url: hit.url!, snippet: hit.content ?? "" }));
    },
  };
}
