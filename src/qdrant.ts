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
//
// ---- what a "v2" collection is ------------------------------------------
//
// v1 stored one unnamed dense vector and an empty payload, which made this a
// rank-only sidecar: nothing to filter on, and dense embeddings alone miss the
// rare exact terms this corpus is full of (periodiseringsfond, mcp-lint,
// Fortnox, a product name). v2 stores:
//
//   - a NAMED dense vector ("dense"), so a second vector can coexist;
//   - a sparse BM25 vector ("sparse", idf modifier), queried alongside the
//     dense one and fused with Reciprocal Rank Fusion -- lexical recall for
//     exact terms, semantic recall for everything else;
//   - a real payload (goal_id, kind, confidence, muted, created_at) plus the
//     indexes Qdrant requires before it will filter on any of them.
//
// The shape change is why the collections are versioned rather than migrated
// in place. Rolling back is setting COLLECTION_VERSION to 1: the old
// collections are untouched, and syncToQdrant rebuilds whichever version is
// current from SQLite, which is the source of truth for every point anyway.

const BASE_URL = (process.env.QDRANT_URL ?? "").replace(/\/+$/, "");
const API_KEY = process.env.QDRANT_API_KEY;
const MODEL = process.env.QDRANT_EMBEDDING_MODEL;
const DIM = process.env.QDRANT_EMBEDDING_DIM ? Number(process.env.QDRANT_EMBEDDING_DIM) : undefined;
const DISTANCE = process.env.QDRANT_EMBEDDING_DISTANCE || "Cosine";

/**
 * Qdrant-hosted sparse model for the lexical half of hybrid search. Unlike the dense model this
 * has a sensible default: BM25 is provided by Qdrant itself and has no dimension to match, so
 * there's nothing per-cluster to look up. Set QDRANT_SPARSE_MODEL empty (or "off") to fall back
 * to dense-only search -- the escape hatch if a cluster's inference tier doesn't offer it.
 */
const SPARSE_MODEL_RAW = process.env.QDRANT_SPARSE_MODEL ?? "Qdrant/bm25";
const SPARSE_MODEL = SPARSE_MODEL_RAW.toLowerCase() === "off" ? "" : SPARSE_MODEL_RAW;
const HYBRID = Boolean(SPARSE_MODEL);

/**
 * Bump to change the stored collection shape. 1 = the original unnamed-dense, empty-payload form,
 * which the v1 branches below still support so a rollback is a one-line change rather than a
 * revert. Typed as `number` so those branches aren't narrowed away as dead code.
 */
const COLLECTION_VERSION: number = 2;

export const qdrantAvailable = Boolean(BASE_URL && API_KEY && MODEL && DIM);

/** Logical collection names -- these match the SQLite table each one mirrors. */
export type CollectionName = "research_notes" | "lessons";

/** v1 collections have no suffix, so rolling the version back reaches exactly the old ones. */
function physical(collection: CollectionName): string {
  return COLLECTION_VERSION === 1 ? collection : `${collection}_v${COLLECTION_VERSION}`;
}

function headers(): Record<string, string> {
  return { "api-key": API_KEY!, "Content-Type": "application/json" };
}

/**
 * Payload fields worth filtering on, and the schema Qdrant needs to do it. Filtering on an
 * unindexed field is not slow -- it is a 400 ("Index required but not found for ..."), so these
 * are a prerequisite rather than a performance tweak.
 */
const PAYLOAD_INDEXES: { field: string; schema: string }[] = [
  { field: "goal_id", schema: "integer" },
  { field: "kind", schema: "keyword" },
  { field: "muted", schema: "integer" },
  { field: "created_at", schema: "datetime" },
];

// Collections confirmed (or in the process of being confirmed) to exist this
// process -- avoids a GET before every write/search once a collection's
// presence has been established, and de-dupes concurrent first-time callers
// (e.g. syncToQdrant's Promise.all) onto a single in-flight attempt so they
// don't race each other to create the same collection.
const ensuredCollections = new Map<string, Promise<boolean>>();

function ensureCollection(collection: CollectionName): Promise<boolean> {
  if (!qdrantAvailable) return Promise.resolve(false);
  const name = physical(collection);
  let promise = ensuredCollections.get(name);
  if (!promise) {
    promise = ensureCollectionUncached(name);
    ensuredCollections.set(name, promise);
    // Don't cache a failed attempt -- let a later call retry from scratch.
    promise.then((ok) => {
      if (!ok) ensuredCollections.delete(name);
    });
  }
  return promise;
}

async function ensureCollectionUncached(name: string): Promise<boolean> {
  try {
    const existing = await fetch(`${BASE_URL}/collections/${name}`, { headers: headers() });
    if (!existing.ok) {
      const body: Record<string, unknown> =
        COLLECTION_VERSION === 1
          ? { vectors: { size: DIM, distance: DISTANCE } }
          : { vectors: { dense: { size: DIM, distance: DISTANCE } } };
      if (COLLECTION_VERSION > 1 && HYBRID) {
        // "idf" is what makes this BM25 rather than raw term frequency -- Qdrant computes the
        // inverse document frequency across the collection at query time.
        body.sparse_vectors = { sparse: { modifier: "idf" } };
      }
      const created = await fetch(`${BASE_URL}/collections/${name}`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify(body),
      });
      // 409 = another process (or a lost local race) created it first -- that's the
      // desired end state, not a failure.
      if (!created.ok && created.status !== 409) {
        console.error(`[qdrant] failed to create collection ${name}: ${created.status} ${await created.text()}`);
        return false;
      }
    }
    // Runs once per process per collection, whether or not this call created it: creating an
    // index that already exists is a no-op, and an existing collection from an earlier build
    // may predate one of these fields.
    if (COLLECTION_VERSION > 1) await ensurePayloadIndexes(name);
    return true;
  } catch (err) {
    console.error(`[qdrant] ensureCollection(${name}) failed:`, err);
    return false;
  }
}

/** Best-effort: a missing index costs filtering on that one field, not the whole search. */
async function ensurePayloadIndexes(name: string): Promise<void> {
  for (const { field, schema } of PAYLOAD_INDEXES) {
    try {
      const res = await fetch(`${BASE_URL}/collections/${name}/index?wait=true`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ field_name: field, field_schema: schema }),
      });
      if (!res.ok) {
        console.error(`[qdrant] payload index ${name}.${field} failed: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.error(`[qdrant] payload index ${name}.${field} failed:`, err);
    }
  }
}

/** One point's worth of input: the id is the SQLite rowid, so an upsert overwrites in place. */
export interface QdrantPoint {
  id: number;
  text: string;
  payload?: Record<string, unknown>;
}

/** The vector object for one point -- both legs embedded server-side from the same text. */
function vectorFor(text: string): Record<string, unknown> {
  if (COLLECTION_VERSION === 1) return { text, model: MODEL };
  const vector: Record<string, unknown> = { dense: { text, model: MODEL } };
  if (HYBRID) vector.sparse = { text, model: SPARSE_MODEL };
  return vector;
}

/** Upsert a point whose vector is generated server-side from `text` by Qdrant Cloud Inference. */
export async function upsertText(
  collection: CollectionName,
  id: number,
  text: string,
  payload?: Record<string, unknown>
): Promise<boolean> {
  return upsertMany(collection, [{ id, text, payload }]);
}

/**
 * Batched upsert. One request per batch rather than per point: syncToQdrant used to issue N
 * individual `?wait=true` PUTs at every startup, which is invisible at 50 rows and won't stay so.
 */
export async function upsertMany(collection: CollectionName, points: QdrantPoint[]): Promise<boolean> {
  if (!qdrantAvailable || points.length === 0) return false;
  if (!(await ensureCollection(collection))) return false;

  try {
    const res = await fetch(`${BASE_URL}/collections/${physical(collection)}/points?wait=true`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({
        points: points.map((p) => ({ id: p.id, payload: p.payload ?? {}, vector: vectorFor(p.text) })),
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

/**
 * Update a point's payload without touching its vector.
 *
 * Matters because filtering is now server-side: muting a lesson updates a payload field the
 * search filters on, so a mute written only to SQLite would leave the lesson still being returned
 * to the model. Using set_payload rather than a full re-upsert keeps it a metadata write -- no
 * re-embedding, no inference cost, for a change that never alters the text.
 */
export async function setPayload(
  collection: CollectionName,
  id: number,
  payload: Record<string, unknown>
): Promise<boolean> {
  if (!qdrantAvailable) return false;
  if (!(await ensureCollection(collection))) return false;

  try {
    const res = await fetch(`${BASE_URL}/collections/${physical(collection)}/points/payload?wait=true`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ payload, points: [id] }),
    });
    if (!res.ok) {
      console.error(`[qdrant] set_payload on ${collection}#${id} failed: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[qdrant] set_payload on ${collection}#${id} failed:`, err);
    return false;
  }
}

/** Remove a point whose backing SQLite row is gone, so it can't surface in a later search. */
export async function deletePoint(collection: CollectionName, id: number): Promise<boolean> {
  if (!qdrantAvailable) return false;
  if (!(await ensureCollection(collection))) return false;

  try {
    const res = await fetch(`${BASE_URL}/collections/${physical(collection)}/points/delete?wait=true`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ points: [id] }),
    });
    if (!res.ok) {
      console.error(`[qdrant] delete from ${collection} failed: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[qdrant] delete from ${collection} failed:`, err);
    return false;
  }
}

/** A Qdrant filter clause. Kept loose on purpose -- callers build the few shapes they need below. */
export type QdrantFilter = Record<string, unknown>;

export interface QdrantHit {
  id: number;
  score: number;
  payload?: Record<string, unknown>;
}

export interface SearchOptions {
  /** Server-side payload filter. Requires an index on each field used -- see PAYLOAD_INDEXES. */
  filter?: QdrantFilter;
  /**
   * Minimum cosine similarity, applied to the dense leg. Not applied to the fused result: RRF
   * scores are rank-derived (1.0, 0.5, 0.33...) and carry no similarity meaning, so thresholding
   * them would silently cut by position rather than by relevance.
   */
  scoreThreshold?: number;
  /**
   * Skip the sparse leg and return raw cosine scores.
   *
   * Needed wherever the *value* of the score is load-bearing rather than just its order --
   * "is this the same lesson reworded?" is a question about similarity, and under fusion the top
   * hit scores 1.0 whether it's a near-identical duplicate or the least-irrelevant row in a
   * collection of ten. Ranking callers should leave this off and take the better recall.
   */
  denseOnly?: boolean;
}

interface QueryResponse {
  result: { points: QdrantHit[] };
}

async function query(collection: CollectionName, body: Record<string, unknown>, label: string): Promise<QdrantHit[] | null> {
  if (!qdrantAvailable) return null;
  if (!(await ensureCollection(collection))) return null;

  try {
    const res = await fetch(`${BASE_URL}/collections/${physical(collection)}/points/query`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ with_payload: true, ...body }),
    });
    if (!res.ok) {
      console.error(`[qdrant] ${label} in ${collection} failed: ${res.status} ${await res.text()}`);
      return null;
    }
    const parsed = (await res.json()) as QueryResponse;
    return parsed.result.points;
  } catch (err) {
    console.error(`[qdrant] ${label} in ${collection} failed:`, err);
    return null;
  }
}

/**
 * Search by raw text (embedded server-side) -- ids ranked best-first, or null on any failure.
 *
 * Null means "the search did not happen" and is the signal callers fall back to LIKE on. An empty
 * array means "the search ran and nothing matched", which is a real answer and must not trigger a
 * fallback -- v1 conflated the two, so a genuinely empty result quietly re-ran as a substring
 * match and returned unrelated rows.
 */
export async function searchByText(
  collection: CollectionName,
  text: string,
  limit: number,
  opts: SearchOptions = {}
): Promise<QdrantHit[] | null> {
  if (COLLECTION_VERSION === 1) {
    return query(collection, { query: { text, model: MODEL }, limit, filter: opts.filter }, "search");
  }

  if (!HYBRID || opts.denseOnly) {
    return query(
      collection,
      { query: { text, model: MODEL }, using: "dense", limit, filter: opts.filter, score_threshold: opts.scoreThreshold },
      "search"
    );
  }

  // Over-fetch each leg relative to the final limit: fusion is only as good as the candidates it
  // sees, and a term the sparse leg ranks 12th can still be the best answer after fusion.
  const prefetchLimit = Math.max(limit * 4, 20);
  return query(
    collection,
    {
      prefetch: [
        {
          query: { text, model: MODEL },
          using: "dense",
          limit: prefetchLimit,
          filter: opts.filter,
          score_threshold: opts.scoreThreshold,
        },
        { query: { text, model: SPARSE_MODEL }, using: "sparse", limit: prefetchLimit, filter: opts.filter },
      ],
      query: { fusion: "rrf" },
      limit,
    },
    "hybrid search"
  );
}

/**
 * "Find things like this, but unlike those."
 *
 * The vector-native answer to a research loop that keeps re-treading: the goal's own text is the
 * positive, and the notes already recorded as dead ends are the negatives, so what comes back is
 * ranked by being *on topic and unlike what's been ruled out*. Dense-only -- there is no sparse
 * equivalent of "unlike", and BM25 has no notion of a negative example.
 *
 * `positiveText` is embedded server-side in the same request; negatives are point ids, which is
 * what makes this cheap (no re-embedding of the notes being avoided).
 */
export async function recommendByText(
  collection: CollectionName,
  positiveText: string,
  negativeIds: number[],
  limit: number,
  opts: SearchOptions = {}
): Promise<QdrantHit[] | null> {
  if (!qdrantAvailable || COLLECTION_VERSION === 1) return null;
  return query(
    collection,
    {
      query: {
        recommend: {
          positive: [{ text: positiveText, model: MODEL }],
          negative: negativeIds,
          // best_score ranks by "closest to any positive, minus closest to any negative", which
          // is what "on topic but not that" means. The default (average_vector) blends the
          // negatives into one centroid and blurs exactly the distinction being asked for.
          strategy: "best_score",
        },
      },
      using: "dense",
      limit,
      filter: opts.filter,
    },
    "recommend"
  );
}

// ---- filter builders -------------------------------------------------------
//
// Small helpers rather than callers hand-rolling Qdrant's JSON: the field names have to match
// PAYLOAD_INDEXES exactly or the request 400s, and that's worth having in one place.

export function goalFilter(goalId: number | null | undefined): QdrantFilter | undefined {
  return goalId == null ? undefined : { must: [{ key: "goal_id", match: { value: goalId } }] };
}

/** Combines clauses, dropping the undefined ones; returns undefined when nothing is left to filter on. */
export function andFilters(...filters: (QdrantFilter | undefined)[]): QdrantFilter | undefined {
  const must = filters.flatMap((f) => (f?.must as unknown[]) ?? []);
  const mustNot = filters.flatMap((f) => (f?.must_not as unknown[]) ?? []);
  if (must.length === 0 && mustNot.length === 0) return undefined;
  return { ...(must.length ? { must } : {}), ...(mustNot.length ? { must_not: mustNot } : {}) };
}

export function kindFilter(kind: string): QdrantFilter {
  return { must: [{ key: "kind", match: { value: kind } }] };
}

/**
 * Excludes muted lessons server-side. v1 filtered them in JS after the fact and over-fetched
 * `limit * 2` to compensate, which still silently shrank the result set when several top hits
 * were muted. `is_empty` covers points written before `muted` was part of the payload.
 */
export function notMutedFilter(): QdrantFilter {
  return { must_not: [{ key: "muted", match: { value: 1 } }] };
}
