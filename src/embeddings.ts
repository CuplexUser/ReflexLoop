// src/embeddings.ts
//
// Thin client for Voyage AI embeddings (Anthropic's recommended embeddings
// provider -- there's no first-party Anthropic embeddings endpoint).
// Deliberately fails soft: with no VOYAGE_API_KEY set, or on any request
// error, embed() resolves to null rather than throwing, so callers can fall
// back to the old LIKE-based search instead of breaking research/reflect.
//
// A key only authenticates against the endpoint it was issued for -- a key
// from dashboard.voyageai.com works at api.voyageai.com; a MongoDB
// Atlas-issued "Model API key" only works at ai.mongodb.com (same request/
// response schema either way). VOYAGE_API_BASE_URL picks which one to call.

const VOYAGE_MODEL = "voyage-3.5";
const API_KEY = process.env.VOYAGE_API_KEY;
const API_BASE_URL = process.env.VOYAGE_API_BASE_URL ?? "https://api.voyageai.com/v1";

export const embeddingsAvailable = Boolean(API_KEY);

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
}

async function requestEmbeddings(texts: string[], inputType: "document" | "query"): Promise<number[][] | null> {
  if (!API_KEY || texts.length === 0) return null;

  try {
    const res = await fetch(`${API_BASE_URL}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: inputType }),
    });
    if (!res.ok) {
      console.error(`[embeddings] Voyage API error ${res.status}: ${await res.text()}`);
      return null;
    }
    const body = (await res.json()) as VoyageResponse;
    return [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  } catch (err) {
    console.error("[embeddings] request failed:", err);
    return null;
  }
}

/** Embed text being stored (a research note's finding, a lesson's text). */
export function embedDocument(text: string): Promise<number[] | null> {
  return requestEmbeddings([text], "document").then((rows) => rows?.[0] ?? null);
}

/** Embed a search query -- Voyage optimizes query/document embeddings differently. */
export function embedQuery(text: string): Promise<number[] | null> {
  return requestEmbeddings([text], "query").then((rows) => rows?.[0] ?? null);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
