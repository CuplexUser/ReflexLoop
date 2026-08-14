// src/search/brave.ts
//
// Brave returns ordinary web results -- title, URL, and a short SERP description --
// so the research phase does more of its own reading via WebFetch than it does on
// Tavily. Cheaper and more neutral; more tokens spent on follow-up fetches.

import type { SearchProvider, SearchResult } from "./types.js";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
/** Brave's own per-request ceiling; asking for more is an error, not a clamp. */
const MAX_COUNT = 20;

interface BraveResponse {
  web?: { results?: { title?: string; url?: string; description?: string }[] };
}

/** Brave descriptions come back with <strong> highlighting around the matched terms. */
function stripHighlights(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

export function createBraveProvider(apiKey: string): SearchProvider {
  return {
    name: "brave",
    async search(query: string, limit: number): Promise<SearchResult[]> {
      const url = new URL(ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(limit, MAX_COUNT)));
      const res = await fetch(url, {
        headers: { accept: "application/json", "x-subscription-token": apiKey },
      });
      if (!res.ok) {
        throw new Error(`Brave search failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
      }
      const json = (await res.json()) as BraveResponse;
      return (json.web?.results ?? [])
        .filter((hit) => hit.url)
        .map((hit) => ({
          title: stripHighlights(hit.title ?? hit.url!),
          url: hit.url!,
          snippet: stripHighlights(hit.description ?? ""),
        }));
    },
  };
}
