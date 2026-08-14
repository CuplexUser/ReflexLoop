// src/search/types.ts
//
// The seam that lets WebSearch be backed by a different service without touching
// anything that calls it. Two implementations ship (Tavily, Brave); a third mode,
// "native", bypasses this interface entirely and asks the model's own provider to
// search server-side -- see index.ts.

export interface SearchResult {
  title: string;
  url: string;
  /** Snippet or extract. Tavily returns a summarized passage; Brave returns a SERP description. */
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}
