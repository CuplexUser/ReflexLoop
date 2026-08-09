// src/memory-server.ts
//
// A single SQLite database backs both:
//   1. an in-process MCP server (tools the Claude agent calls itself), and
//   2. a plain TypeScript class (MemoryStore) the orchestrator calls directly
//      for things the agent should never control, e.g. reading pending
//      proposals for human review, or recording the human's decision.
//
// Split like that on purpose: the agent gets read/write access to research,
// lessons, and its own proposals. It never gets a tool that approves its own
// spending, and it never gets a tool that logs actions on its own tool calls
// -- those are handled automatically by orchestrator.ts hooks so the audit
// trail can't be skipped by the model forgetting to call a "log this" tool.

import { DatabaseSync } from "node:sqlite";
import { tool, createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { emitAgentEvent } from "./events.js";
import { cosineSimilarity, embedDocument, embedQuery } from "./embeddings.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS research_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  finding TEXT NOT NULL,
  source TEXT,
  confidence REAL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  description TEXT NOT NULL,
  expected_cost REAL NOT NULL,
  expected_time_hours REAL NOT NULL,
  expected_upside REAL NOT NULL,
  required_tools TEXT NOT NULL,          -- comma-separated tool names, e.g. "WebSearch,WebFetch"
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  human_notes TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER REFERENCES proposals(id),
  phase TEXT NOT NULL,                   -- research | plan | act | reflect
  tool_name TEXT NOT NULL,
  tool_input TEXT,
  tool_output TEXT,
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  actual_revenue REAL NOT NULL DEFAULT 0,
  actual_cost REAL NOT NULL DEFAULT 0,    -- include Claude API spend, not just external cost
  actual_time_hours REAL,
  success INTEGER NOT NULL,               -- 0 or 1
  notes TEXT,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  lesson TEXT NOT NULL,
  derived_from_outcome_id INTEGER REFERENCES outcomes(id),
  confidence REAL NOT NULL DEFAULT 0.5,
  times_reinforced INTEGER NOT NULL DEFAULT 0,
  times_contradicted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER REFERENCES proposals(id),
  phase TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  duration_ms INTEGER,
  started_at TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();

export class MemoryStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // JSON-encoded embedding vectors, populated at write time when
    // VOYAGE_API_KEY is set. NULL rows (no key, or the embedding call
    // failed) are excluded from semantic ranking and search falls back to
    // LIKE. Added via a runtime check rather than `ADD COLUMN IF NOT
    // EXISTS` since that syntax isn't supported by every SQLite build.
    this.ensureColumn("research_notes", "embedding", "TEXT");
    this.ensureColumn("lessons", "embedding", "TEXT");
  }

  private ensureColumn(table: string, column: string, type: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  close() {
    this.db.close();
  }

  // ---- research ---------------------------------------------------------

  async addResearchNote(topic: string, finding: string, source?: string, confidence?: number) {
    const embedding = await embedDocument(`${topic}: ${finding}`);
    const stmt = this.db.prepare(
      `INSERT INTO research_notes (topic, finding, source, confidence, fetched_at, embedding) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      topic,
      finding,
      source ?? null,
      confidence ?? null,
      now(),
      embedding ? JSON.stringify(embedding) : null
    );
    return Number(result.lastInsertRowid);
  }

  /** Semantic search when embeddings are available, falling back to LIKE otherwise. */
  async searchResearchNotes(topic: string, limit = 10) {
    const semantic = await this.semanticSearch<ResearchNoteRow>("research_notes", topic, limit);
    if (semantic) return semantic;

    const stmt = this.db.prepare(
      `SELECT * FROM research_notes WHERE topic LIKE ? OR finding LIKE ? ORDER BY fetched_at DESC LIMIT ?`
    );
    return (stmt.all(`%${topic}%`, `%${topic}%`, limit) as unknown as ResearchNoteRow[]).map(omitEmbedding);
  }

  listAllResearchNotes(limit = 200) {
    return (
      this.db.prepare(`SELECT * FROM research_notes ORDER BY fetched_at DESC LIMIT ?`).all(limit) as unknown as ResearchNoteRow[]
    ).map(omitEmbedding);
  }

  /** Cosine-similarity ranking over `table`'s embedding column; null if no query embedding could be produced. */
  private async semanticSearch<T extends { embedding: string | null }>(
    table: "research_notes" | "lessons",
    query: string,
    limit: number
  ): Promise<Omit<T, "embedding">[] | null> {
    const queryEmbedding = await embedQuery(query);
    if (!queryEmbedding) return null;

    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE embedding IS NOT NULL`).all() as T[];
    if (rows.length === 0) return null;

    return rows
      .map((row) => ({ row, score: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding as string)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row }) => omitEmbedding(row));
  }

  // ---- proposals ----------------------------------------------------------

  createProposal(p: {
    domain: string;
    description: string;
    expectedCost: number;
    expectedTimeHours: number;
    expectedUpside: number;
    requiredTools: string[];
  }) {
    const stmt = this.db.prepare(
      `INSERT INTO proposals (domain, description, expected_cost, expected_time_hours, expected_upside, required_tools, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      p.domain,
      p.description,
      p.expectedCost,
      p.expectedTimeHours,
      p.expectedUpside,
      p.requiredTools.join(","),
      now()
    );
    return Number(result.lastInsertRowid);
  }

  getProposal(id: number) {
    return this.db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(id) as ProposalRow | undefined;
  }

  listPendingProposals() {
    return this.db.prepare(`SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at ASC`).all() as unknown as ProposalRow[];
  }

  listAllProposals() {
    return this.db.prepare(`SELECT * FROM proposals ORDER BY created_at DESC`).all() as unknown as ProposalRow[];
  }

  decideProposal(id: number, status: "approved" | "rejected", humanNotes?: string) {
    this.db
      .prepare(`UPDATE proposals SET status = ?, human_notes = ?, decided_at = ? WHERE id = ?`)
      .run(status, humanNotes ?? null, now(), id);
  }

  // ---- actions (written by orchestrator hooks, not by the model) --------

  logAction(proposalId: number | null, phase: string, toolName: string, toolInput: unknown, toolOutput: unknown) {
    this.db
      .prepare(
        `INSERT INTO actions (proposal_id, phase, tool_name, tool_input, tool_output, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(proposalId, phase, toolName, safeJson(toolInput), safeJson(toolOutput), now());
  }

  listActions(proposalId: number) {
    return this.db
      .prepare(`SELECT * FROM actions WHERE proposal_id = ? ORDER BY occurred_at ASC`)
      .all(proposalId);
  }

  // ---- outcomes -----------------------------------------------------------

  recordOutcome(o: {
    proposalId: number;
    actualRevenue: number;
    actualCost: number;
    actualTimeHours?: number;
    success: boolean;
    notes?: string;
  }) {
    const stmt = this.db.prepare(
      `INSERT INTO outcomes (proposal_id, actual_revenue, actual_cost, actual_time_hours, success, notes, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      o.proposalId,
      o.actualRevenue,
      o.actualCost,
      o.actualTimeHours ?? null,
      o.success ? 1 : 0,
      o.notes ?? null,
      now()
    );
    return Number(result.lastInsertRowid);
  }

  listOutcomes() {
    return this.db
      .prepare(
        `SELECT o.*, p.description AS proposal_description, p.domain AS proposal_domain
         FROM outcomes o JOIN proposals p ON p.id = o.proposal_id
         ORDER BY o.recorded_at DESC`
      )
      .all();
  }

  // ---- lessons --------------------------------------------------------------

  listAllLessons(limit = 200) {
    return (
      this.db.prepare(`SELECT * FROM lessons ORDER BY updated_at DESC LIMIT ?`).all(limit) as unknown as LessonRow[]
    ).map(omitEmbedding);
  }

  /**
   * Semantic search over domain+lesson text when embeddings are available --
   * this is what lets a lesson written for "VS Code extension for
   * productivity" still surface for a proposal in "VS Code extensions",
   * where the old exact `domain = ?` match would miss it. Falls back to
   * exact domain equality (the original behavior) when no embedding could
   * be produced.
   */
  async searchLessons(domain: string, limit = 10) {
    const semantic = await this.semanticSearch<LessonRow>("lessons", domain, limit);
    if (semantic) return semantic;

    return (
      this.db
        .prepare(`SELECT * FROM lessons WHERE domain = ? ORDER BY confidence DESC, updated_at DESC LIMIT ?`)
        .all(domain, limit) as unknown as LessonRow[]
    ).map(omitEmbedding);
  }

  async addLesson(domain: string, lessonText: string, derivedFromOutcomeId?: number) {
    const embedding = await embedDocument(`${domain}: ${lessonText}`);
    const stmt = this.db.prepare(
      `INSERT INTO lessons (domain, lesson, derived_from_outcome_id, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const t = now();
    const result = stmt.run(
      domain,
      lessonText,
      derivedFromOutcomeId ?? null,
      t,
      t,
      embedding ? JSON.stringify(embedding) : null
    );
    return Number(result.lastInsertRowid);
  }

  reinforceLesson(id: number, direction: "confirmed" | "contradicted") {
    if (direction === "confirmed") {
      this.db
        .prepare(
          `UPDATE lessons SET times_reinforced = times_reinforced + 1,
           confidence = MIN(1.0, confidence + 0.1), updated_at = ? WHERE id = ?`
        )
        .run(now(), id);
    } else {
      this.db
        .prepare(
          `UPDATE lessons SET times_contradicted = times_contradicted + 1,
           confidence = MAX(0.0, confidence - 0.2), updated_at = ? WHERE id = ?`
        )
        .run(now(), id);
    }
  }

  // ---- runs (Claude API cost per phase, so spend counts against profit) --

  logRun(proposalId: number | null, phase: string, costUsd: number, durationMs: number | undefined, startedAt: string) {
    this.db
      .prepare(`INSERT INTO runs (proposal_id, phase, cost_usd, duration_ms, started_at) VALUES (?, ?, ?, ?, ?)`)
      .run(proposalId, phase, costUsd, durationMs ?? null, startedAt);
  }

  listRuns(limit = 200) {
    return this.db.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`).all(limit);
  }

  totalRunCost(): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs`).get() as { total: number };
    return row.total;
  }
}

interface ResearchNoteRow {
  id: number;
  topic: string;
  finding: string;
  source: string | null;
  confidence: number | null;
  fetched_at: string;
  embedding: string | null;
}

interface LessonRow {
  id: number;
  domain: string;
  lesson: string;
  derived_from_outcome_id: number | null;
  confidence: number;
  times_reinforced: number;
  times_contradicted: number;
  created_at: string;
  updated_at: string;
  embedding: string | null;
}

function omitEmbedding<T extends { embedding: string | null }>(row: T): Omit<T, "embedding"> {
  const { embedding: _embedding, ...rest } = row;
  return rest;
}

export interface ProposalRow {
  id: number;
  domain: string;
  description: string;
  expected_cost: number;
  expected_time_hours: number;
  expected_upside: number;
  required_tools: string;
  status: "pending" | "approved" | "rejected";
  human_notes: string | null;
  created_at: string;
  decided_at: string | null;
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---- MCP tool definitions ----------------------------------------------
//
// These are the only memory operations the agent itself can call. Notice
// what's absent: no tool to approve a proposal, no tool to mark itself
// successful, no tool that touches real money. Those stay in the
// orchestrator's hands.

export function buildMemoryServer(store: MemoryStore): McpSdkServerConfigWithInstance {
  const researchNoteAdd = tool(
    "research_note_add",
    "Save a distilled research finding for later reuse. Call this after reading a source, not raw page dumps -- write the takeaway in your own words.",
    {
      topic: z.string().describe("Short topic key, e.g. 'print-on-demand margins'"),
      finding: z.string().describe("The distilled finding, one or two sentences"),
      source: z.string().optional().describe("URL or reference"),
      confidence: z.number().min(0).max(1).optional(),
    },
    async ({ topic, finding, source, confidence }) => {
      const id = await store.addResearchNote(topic, finding, source, confidence);
      return { content: [{ type: "text", text: `Saved research note #${id}` }] };
    }
  );

  const researchNoteSearch = tool(
    "research_note_search",
    "Check what has already been researched on a topic before spending a web search cycle re-discovering it.",
    { topic: z.string(), limit: z.number().int().positive().max(50).optional() },
    async ({ topic, limit }) => {
      const rows = await store.searchResearchNotes(topic, limit ?? 10);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }
  );

  const lessonSearch = tool(
    "lesson_search",
    "Retrieve lessons learned from past attempts in a domain, ranked by confidence. Call this before proposing or planning anything.",
    { domain: z.string(), limit: z.number().int().positive().max(50).optional() },
    async ({ domain, limit }) => {
      const rows = await store.searchLessons(domain, limit ?? 10);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }
  );

  const lessonAdd = tool(
    "lesson_add",
    "Record a new, generalized lesson (not a raw log of what happened -- the reusable takeaway). Use during the reflect phase.",
    {
      domain: z.string(),
      lesson: z.string().describe("Generalized, reusable takeaway, not a play-by-play of one event"),
      derivedFromOutcomeId: z.number().int().optional(),
    },
    async ({ domain, lesson, derivedFromOutcomeId }) => {
      const id = await store.addLesson(domain, lesson, derivedFromOutcomeId);
      emitAgentEvent({ type: "lesson_saved", domain });
      return { content: [{ type: "text", text: `Saved lesson #${id}` }] };
    }
  );

  const lessonReinforce = tool(
    "lesson_reinforce",
    "Adjust an existing lesson's confidence instead of creating a duplicate, when a new outcome confirms or contradicts it.",
    { id: z.number().int(), direction: z.enum(["confirmed", "contradicted"]) },
    async ({ id, direction }) => {
      store.reinforceLesson(id, direction);
      return { content: [{ type: "text", text: `Lesson #${id} marked ${direction}` }] };
    }
  );

  const proposalCreate = tool(
    "proposal_create",
    "Propose a specific, boundable action for a human to approve. Every proposal needs a concrete cost/time/upside estimate and the exact list of tools it needs -- no proposal is executed without human approval, and execution is locked to exactly the tools listed here.",
    {
      domain: z.string(),
      description: z.string().describe("What you'd do, specifically enough that a human can say yes or no"),
      expectedCost: z.number().min(0).describe("Expected cost in your currency of choice, e.g. USD"),
      expectedTimeHours: z.number().min(0),
      expectedUpside: z.number().describe("Expected revenue or value if it works"),
      requiredTools: z.array(z.string()).describe("Exact tool names needed for execution, e.g. ['WebSearch','WebFetch']"),
    },
    async ({ domain, description, expectedCost, expectedTimeHours, expectedUpside, requiredTools }) => {
      const id = store.createProposal({
        domain,
        description,
        expectedCost,
        expectedTimeHours,
        expectedUpside,
        requiredTools,
      });
      return { content: [{ type: "text", text: `Created proposal #${id}, status: pending. Stop here and wait for review -- do not act on it.` }] };
    }
  );

  const proposalStatus = tool(
    "proposal_status",
    "Check whether a previously created proposal has been approved, rejected, or is still pending.",
    { id: z.number().int() },
    async ({ id }) => {
      const row = store.getProposal(id);
      if (!row) return { content: [{ type: "text", text: "No such proposal" }] };
      return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
    }
  );

  const outcomeRecord = tool(
    "outcome_record",
    "Record what actually happened after executing an approved proposal -- real revenue, real cost (including time value if relevant), and whether it succeeded. Be honest here; the reflect phase depends on it.",
    {
      proposalId: z.number().int(),
      actualRevenue: z.number(),
      actualCost: z.number(),
      actualTimeHours: z.number().optional(),
      success: z.boolean(),
      notes: z.string().optional(),
    },
    async ({ proposalId, actualRevenue, actualCost, actualTimeHours, success, notes }) => {
      const id = store.recordOutcome({ proposalId, actualRevenue, actualCost, actualTimeHours, success, notes });
      emitAgentEvent({ type: "outcome_recorded", proposalId });
      return { content: [{ type: "text", text: `Recorded outcome #${id}` }] };
    }
  );

  return createSdkMcpServer({
    name: "memory",
    version: "1.0.0",
    tools: [
      researchNoteAdd,
      researchNoteSearch,
      lessonSearch,
      lessonAdd,
      lessonReinforce,
      proposalCreate,
      proposalStatus,
      outcomeRecord,
    ],
  });
}
