// src/mcp-server.ts
//
// An MCP server that lets Claude Desktop (or any MCP client) read this agent's
// research notes and lessons. Read-only, and read-only twice over: the store is
// opened with SQLite itself rejecting writes, and the only four tools registered
// here are searches and listings. There is deliberately no tool that adds, edits,
// mutes or deletes anything -- curating this memory is a human act performed in
// the console, and an outside client reaching in to write would be a second,
// unaudited path into the record the loop reasons from.
//
// It talks to the database directly rather than to src/server.ts's REST API, so
// it works whether or not `npm start` is running and needs no port and no
// AGENT_API_TOKEN. The cost is that it must run on the same machine as the DB file.
//
// Search quality comes free: searchResearchNotes/searchLessonsByText take the
// Qdrant semantic path when QDRANT_* is configured in this process's environment
// and fall back to LIKE matching otherwise, exactly as they do for the agent.

// KEEP THIS IMPORT FIRST. It loads .env, and qdrant.ts (reached through memory-server.js)
// reads QDRANT_* at module load -- so anything that reorders these two turns semantic
// search off for the whole process, silently. See the note in mcp-env.ts.
import { DB_PATH } from "./mcp-env.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryStore, NOTE_KINDS, type GoalRow } from "./memory-server.js";

// stdout IS the protocol channel on a stdio transport: one stray console.log from
// deep inside qdrant.ts or memory-server.ts (there are ~20 between them) lands in
// the middle of a JSON-RPC frame and kills the session. Everything that isn't a
// protocol message goes to stderr, which MCP clients surface as server logs.
for (const level of ["log", "info", "debug", "warn"] as const) {
  console[level] = (...args: unknown[]) => console.error(...args);
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
/** Over-fetch for filters the store has no SQL for, then narrow in JS. */
const FILTER_SCAN = 500;

let store: MemoryStore;
try {
  store = new MemoryStore(DB_PATH, { readOnly: true });
} catch (err) {
  console.error(`[mcp] cannot open ${DB_PATH}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ---- goal filtering -------------------------------------------------------

/**
 * Goals are named, not numbered, everywhere a human touches them, so the tools take
 * a title. Resolving it here rather than exposing a fifth `goals_list` tool keeps the
 * surface small: a miss answers with the titles that do exist, which teaches the
 * client the vocabulary in the same turn it got the name wrong.
 */
function resolveGoal(name: string): GoalRow {
  const goals = store.listGoals();
  const needle = name.trim().toLowerCase();
  const exact = goals.find((g) => g.title.toLowerCase() === needle);
  if (exact) return exact;
  const partial = goals.filter((g) => g.title.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  const known = goals.map((g) => `  - ${g.title} (${g.status})`).join("\n");
  throw new Error(
    partial.length > 1
      ? `"${name}" matches ${partial.length} goals. Known goals:\n${known}`
      : `No goal matching "${name}". Known goals:\n${known}`
  );
}

function goalTitles() {
  const byId = new Map<number, string>();
  for (const g of store.listGoals()) byId.set(g.id, g.title);
  return byId;
}

// ---- rendering ------------------------------------------------------------

/** Semantic hits arrive as Scored<T>; the LIKE fallback's rows have no score at all. */
const scoreOf = (row: object) => ("score" in row ? (row as { score: number }).score : undefined);

interface NoteLike {
  id: number;
  topic: string;
  finding: string;
  source: string | null;
  confidence: number | null;
  fetched_at: string;
  goal_id: number | null;
  kind: string | null;
}

interface LessonLike {
  id: number;
  domain: string;
  lesson: string;
  confidence: number;
  times_reinforced: number;
  times_contradicted: number;
  updated_at: string;
  goal_id: number | null;
  edited_at: string | null;
}

function renderNote(row: NoteLike, goals: Map<number, string>) {
  const score = scoreOf(row);
  const meta = [
    `#${row.id}`,
    row.fetched_at.slice(0, 10),
    row.goal_id != null ? `goal: ${goals.get(row.goal_id) ?? row.goal_id}` : undefined,
    row.kind ? `kind: ${row.kind}` : undefined,
    row.confidence != null ? `confidence: ${row.confidence}` : undefined,
    score != null ? `relevance: ${score.toFixed(3)}` : undefined,
  ].filter(Boolean);
  const source = row.source ? `\n\nSource: ${row.source}` : "";
  return `## ${row.topic}\n${meta.join(" · ")}\n\n${row.finding}${source}`.trimEnd();
}

function renderLesson(row: LessonLike, goals: Map<number, string>) {
  const score = scoreOf(row);
  const meta = [
    `#${row.id}`,
    row.updated_at.slice(0, 10),
    row.goal_id != null ? `goal: ${goals.get(row.goal_id) ?? row.goal_id}` : undefined,
    `confidence: ${row.confidence.toFixed(2)}`,
    `reinforced ${row.times_reinforced}x / contradicted ${row.times_contradicted}x`,
    row.edited_at ? "human-edited" : undefined,
    score != null ? `relevance: ${score.toFixed(3)}` : undefined,
  ].filter(Boolean);
  return `## ${row.domain}\n${meta.join(" · ")}\n\n${row.lesson}`.trimEnd();
}

const result = (text: string) => ({ content: [{ type: "text" as const, text }] });

const rendered = (heading: string, blocks: string[], empty: string) =>
  result(blocks.length === 0 ? empty : `${heading} (${blocks.length})\n\n${blocks.join("\n\n---\n\n")}`);

// ---- server ---------------------------------------------------------------

const server = new McpServer({ name: "reflexloop-memory", version: "1.0.0" });

const limitArg = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .optional()
  .describe(`How many rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`);
const goalArg = z
  .string()
  .optional()
  .describe("Restrict to one goal, by its title (case-insensitive; a substring is enough).");
const kindArg = z
  .enum(NOTE_KINDS)
  .optional()
  .describe("Restrict to one kind of finding. 'saturated' means ground already ruled out.");

server.registerTool(
  "research_notes_search",
  {
    title: "Search research notes",
    description:
      "Search the agent's research notes by topic or phrase. Semantic when the agent's vector " +
      "search is configured, substring matching otherwise. Notes are what research found: market " +
      "gaps, competitors, pricing, and dead ends it already ruled out.",
    inputSchema: {
      query: z.string().describe("What to look for."),
      limit: limitArg,
      goal: goalArg,
      kind: kindArg,
    },
  },
  async ({ query, limit, goal, kind }) => {
    const goalId = goal ? resolveGoal(goal).id : undefined;
    const rows = await store.searchResearchNotes(query, limit ?? DEFAULT_LIMIT, { goalId, kind });
    const goals = goalTitles();
    return rendered(
      `Research notes matching "${query}"`,
      rows.map((r) => renderNote(r, goals)),
      `No research notes matched "${query}".`
    );
  }
);

server.registerTool(
  "research_notes_list",
  {
    title: "List recent research notes",
    description:
      "The agent's most recent research notes, newest first. Use this to browse rather than search.",
    inputSchema: { limit: limitArg, goal: goalArg, kind: kindArg },
  },
  async ({ limit, goal, kind }) => {
    const goalId = goal ? resolveGoal(goal).id : undefined;
    const filtered = goalId != null || kind != null;
    const rows = store
      .listAllResearchNotes(filtered ? FILTER_SCAN : (limit ?? DEFAULT_LIMIT))
      .filter((r) => (goalId == null || r.goal_id === goalId) && (!kind || r.kind === kind))
      .slice(0, limit ?? DEFAULT_LIMIT);
    const goals = goalTitles();
    return rendered("Recent research notes", rows.map((r) => renderNote(r, goals)), "No research notes on file.");
  }
);

server.registerTool(
  "lessons_search",
  {
    title: "Search lessons",
    description:
      "Search the lessons the agent distilled from real outcomes. Muted lessons -- ones a human " +
      "judged wrong -- are excluded, the same way they are for the agent itself. Each lesson " +
      "carries a confidence and how often it has been reinforced or contradicted since.",
    inputSchema: { query: z.string().describe("What to look for."), limit: limitArg },
  },
  async ({ query, limit }) => {
    const rows = await store.searchLessonsByText(query, limit ?? DEFAULT_LIMIT);
    const goals = goalTitles();
    return rendered(
      `Lessons matching "${query}"`,
      rows.map((r) => renderLesson(r, goals)),
      `No lessons matched "${query}".`
    );
  }
);

server.registerTool(
  "lessons_list",
  {
    title: "List recent lessons",
    description: "The agent's most recently updated lessons, newest first. Muted lessons are excluded.",
    inputSchema: { limit: limitArg, goal: goalArg },
  },
  async ({ limit, goal }) => {
    const goalId = goal ? resolveGoal(goal).id : undefined;
    // listAllLessons is the console's *curation* listing, so it deliberately includes muted
    // rows. This is a reading surface, not a curation one -- a lesson taken out of the agent's
    // reasoning must not come back through a second door.
    const rows = store
      .listAllLessons(FILTER_SCAN)
      .filter((r) => !r.muted && (goalId == null || r.goal_id === goalId))
      .slice(0, limit ?? DEFAULT_LIMIT);
    const goals = goalTitles();
    return rendered("Recent lessons", rows.map((r) => renderLesson(r, goals)), "No lessons on file.");
  }
);

await server.connect(new StdioServerTransport());
console.error(`[mcp] reflexloop-memory serving ${DB_PATH} (read-only)`);
