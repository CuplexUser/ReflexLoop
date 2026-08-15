// src/proposal-similarity.ts
//
// "Is this proposal the one we already have, reworded?"
//
// The research phase is now shown the open proposal queue (see openProposalDigest in
// orchestrator.ts), which removes the blindness that caused most duplicates -- but a prompt
// is advice, and the same idea kept coming back under a new name: #14
// "PropertyManagerCompare", #17 "PropertyManagementSoftware.review" and #20 "Property
// management software comparison site" are one site proposed three times, in three domains,
// two of them pending simultaneously. So the last line of defence is mechanical.
//
// Deliberately lexical rather than semantic: it's a pure function over two strings, so it's
// unit-testable with no API key, no Qdrant, and no embedding call on the hot path of every
// proposal_create -- and when it fires, the operator can be told *which words* collided
// rather than "an opaque model said 0.83". The tokenizer does the work a plain word match
// can't: it splits CamelCase (so "PropertyManagerCompare" is three words) and stems
// (so manager/management, compare/comparison and deploy/deployed are one term each).

/** Structural/filler words: present in every proposal, so they say nothing about which one it is. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "as", "at", "by", "for", "from",
  "in", "into", "of", "on", "onto", "to", "with", "without", "up", "down", "out", "over", "under",
  "no", "not", "so", "such", "can", "will", "would", "should", "could", "may", "might", "must",
  "do", "does", "did", "done", "have", "has", "had", "one", "two", "three", "each", "every", "all",
  "any", "some", "more", "most", "own", "same", "other", "another", "you", "your", "we", "our",
  "they", "their", "there", "here", "what", "which", "who", "when", "where", "how", "why", "per",
  "via", "also", "just", "only", "even", "still", "yet", "about", "after", "before", "while",
]);

/**
 * Suffixes stripped to fold inflections onto one stem, longest first so "management" loses
 * "ment" rather than "t". The 4-character floor keeps short words intact ("site" stays "site").
 */
const SUFFIXES = [
  "izations", "isations", "ization", "isation", "ations", "ation", "ments", "ment", "ities",
  "ities", "ility", "ities", "ising", "izing", "ised", "ized", "isons", "ison", "ions", "ion",
  "ings", "ing", "ives", "ive", "ables", "able", "ibles", "ible", "ness", "ally", "ers", "er",
  "ors", "or", "ies", "ied", "est", "ed", "es", "ly", "al", "s", "y",
].sort((a, b) => b.length - a.length);

/** Folds one word onto its stem: manager/management -> manag, compare/comparison -> compar. */
export function stem(word: string): string {
  let out = word;
  for (const suffix of SUFFIXES) {
    if (out.length - suffix.length >= 4 && out.endsWith(suffix)) {
      out = out.slice(0, -suffix.length);
      break;
    }
  }
  // A trailing vowel left behind by the strip (or never suffixed at all) would split
  // compare/comparison back apart: compar-e vs compar.
  if (out.length > 4 && out.endsWith("e")) out = out.slice(0, -1);
  return out;
}

/**
 * The set of distinctive stems in a proposal's text. A set, not a bag: a description that
 * says "property" nine times is not nine times more about property than one that says it once.
 */
export function terms(text: string): Set<string> {
  const words = text
    .replace(/https?:\/\/\S+/g, " ") // URLs are boilerplate here (vercel.app, github.com)
    .replace(/[*_`#>|~[\]()]/g, " ") // Markdown punctuation -- descriptions are formatted
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // CamelCase is how a product name hides a phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const out = new Set<string>();
  for (const word of words) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    if (/^\d+$/.test(word)) continue; // bare numbers are estimates, not subject matter
    out.add(stem(word));
  }
  return out;
}

export interface Similarity {
  /** Jaccard overlap of the two term sets, 0..1. */
  score: number;
  /** The shared terms, most useful first (longest -- the most specific), for explaining a refusal. */
  shared: string[];
}

/**
 * Jaccard rather than an asymmetric measure like the overlap coefficient: two proposals are
 * peers, and overlap-coefficient scores 1.0 whenever the shorter text is a subset of the
 * longer one, which makes every terse proposal a duplicate of some verbose one.
 */
export function similarity(a: string, b: string): Similarity {
  const left = terms(a);
  const right = terms(b);
  if (left.size === 0 || right.size === 0) return { score: 0, shared: [] };

  const shared: string[] = [];
  for (const term of left) if (right.has(term)) shared.push(term);
  const union = left.size + right.size - shared.length;

  return {
    score: shared.length / union,
    shared: shared.sort((x, y) => y.length - x.length || x.localeCompare(y)),
  };
}

/**
 * Where "too closely related" starts.
 *
 * Measured against the real proposal history rather than picked round. Every pair scored;
 * the two bands and where they end:
 *
 *   duplicates      0.444  #14 PropertyManagerCompare      x #20 Property management software…
 *                   0.396  #12 client-side notice tool     x #13 client-side notice tool
 *                   0.380  #4  Actions Cost Lens (Chrome)  x #5  Actions Cost Lens (VS Code)
 *                   0.378  #17 PropertyManagementSoftware  x #20 Property management software…
 *                   0.371  #9  NoticeCraft                 x #10 NoticeReady
 *                   0.363  #14 PropertyManagerCompare      x #17 PropertyManagementSoftware
 *   ---- 0.32 ----
 *   distinct        0.264  #2  MCP Lint                    x #7  CredLive
 *                   0.254  #15 mcp-lint landing page       x #16 mcp-lint Python SDK support
 *                   0.205  #1  MCP Session Log             x #2  MCP Lint
 *
 * The pair that matters most for the floor is #15 x #16: two genuine next steps on one
 * shipped project, which is exactly the behaviour the research prompt now asks for. It has
 * to stay comfortably under. #14 x #17 -- the same site pending twice at once -- sets the
 * ceiling. 0.32 has ~20% headroom on both sides.
 *
 * Erring low costs a real proposal, so the refusal is not a dead end -- see the message in
 * memory-server.ts, which names the collision and leaves "a next step on #id" open.
 */
export const DUPLICATE_THRESHOLD = 0.32;

export interface CandidateProposal {
  id: number;
  domain: string;
  description: string;
}

export interface DuplicateMatch<T extends CandidateProposal> {
  proposal: T;
  score: number;
  shared: string[];
}

/**
 * The single closest existing proposal above the threshold, or null. Domain is included in the
 * compared text but is *not* a filter: the three rewordings above each arrived under a
 * different domain string ("comparison site / affiliate", "affiliate comparison site",
 * "comparison directory affiliate site"), so scoping the check per-domain would have missed
 * every one of them.
 */
export function findNearDuplicate<T extends CandidateProposal>(
  candidate: { domain: string; description: string },
  existing: readonly T[],
  threshold = DUPLICATE_THRESHOLD
): DuplicateMatch<T> | null {
  const candidateText = `${candidate.domain}\n${candidate.description}`;
  let best: DuplicateMatch<T> | null = null;

  for (const row of existing) {
    const { score, shared } = similarity(candidateText, `${row.domain}\n${row.description}`);
    if (score >= threshold && (best === null || score > best.score)) {
      best = { proposal: row, score, shared };
    }
  }
  return best;
}
