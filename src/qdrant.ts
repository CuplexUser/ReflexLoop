// src/qdrant.ts
//
// Thin REST client for Qdrant Cloud's vector search + built-in (server-side)
// embedding inference. Replaces embeddings.ts (Voyage AI) entirely -- Voyage's
// free-tier rate limits (3 RPM / 10K TPM without a payment method on file)
// were producing frequent 429s. Qdrant Cloud's free-tier "Cost: Free" models
// have no token limit, and the same request also does the vector search, so
// there's no separate embeddings API to rate-limit against.
//
// Deliberately fails soft, same contract as the old embeddings.ts: with no
// QDRANT_URL/QDRANT_API_KEY/QDRANT_EMBEDDING_MODEL/QDRANT_EMBEDDING_DIM set,
// or on any request error, calls resolve to null/false rather than throwing,
// so callers fall back to LIKE-based search instead of breaking
// research/reflect.
//
// Model + dimension aren't hardcoded: Qdrant Cloud's free model lineup and
// each model's vector size are only listed per-cluster (Cloud Console ->
// your cluster -> Inference tab), so both are required env config rather
// than a guessed default that could silently mismatch the collection.

const BASE_URL = (process.env.QDRANT_URL ?? "").replace(/\/+$/, "");
const API_KEY = process.env.QDRANT_API_KEY;
const MODEL = process.env.QDRANT_EMBEDDING_MODEL;
const DIM = process.env.QDRANT_EMBEDDING_DIM ? Number(process.env.QDRANT_EMBEDDING_DIM) : undefined;
const DISTANCE = process.env.QDRANT_EMBEDDING_DISTANCE || "Cosine";

export const qdrantAvailable = Boolean(BASE_URL && API_KEY && MODEL && DIM);

function headers(): Record<string, string> {
  return { "api-key": API_KEY!, "Content-Type": "application/json" };
}

// Collections confirmed to exist this process -- avoids a GET before every
// write/search once a collection's presence has been established.
const ensuredCollections = new Set<string>();

async function ensureCollection(name: string): Promise<boolean> {
  if (ensuredCollections.has(name)) return true;
  if (!qdrantAvailable) return false;

  try {
    const existing = await fetch(`${BASE_URL}/collections/${name}`, { headers: headers() });
    if (existing.ok) {
      ensuredCollections.add(name);
      return true;
    }
    const created = await fetch(`${BASE_URL}/collections/${name}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ vectors: { size: DIM, distance: DISTANCE } }),
    });
    if (!created.ok) {
      console.error(`[qdrant] failed to create collection ${name}: ${created.status} ${await created.text()}`);
      return false;
    }
    ensuredCollections.add(name);
    return true;
  } catch (err) {
    console.error(`[qdrant] ensureCollection(${name}) failed:`, err);
    return false;
  }
}

/** Upsert a point whose vector is generated server-side from `text` by Qdrant Cloud Inference. */
export async function upsertText(
  collection: string,
  id: number,
  text: string,
  payload?: Record<string, unknown>
): Promise<boolean> {
  if (!qdrantAvailable) return false;
  if (!(await ensureCollection(collection))) return false;

  try {
    const res = await fetch(`${BASE_URL}/collections/${collection}/points?wait=true`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({
        points: [{ id, payload: payload ?? {}, vector: { text, model: MODEL } }],
      }),
    });
    if (!res.ok) {
      console.error(`[qdrant] upsert into ${collection} failed: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[qdrant] upsert into ${collection} failed:`, err);
    return false;
  }
}

interface QueryResponse {
  result: { points: { id: number; score: number }[] };
}

/** Search by raw text (embedded server-side) -- returns ids ranked by similarity, or null on any failure. */
export async function searchByText(collection: string, text: string, limit: number): Promise<{ id: number; score: number }[] | null> {
  if (!qdrantAvailable) return null;
  if (!(await ensureCollection(collection))) return null;

  try {
    const res = await fetch(`${BASE_URL}/collections/${collection}/points/query`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ query: { text, model: MODEL }, limit, with_payload: false }),
    });
    if (!res.ok) {
      console.error(`[qdrant] search in ${collection} failed: ${res.status} ${await res.text()}`);
      return null;
    }
    const body = (await res.json()) as QueryResponse;
    return body.result.points;
  } catch (err) {
    console.error(`[qdrant] search in ${collection} failed:`, err);
    return null;
  }
}
