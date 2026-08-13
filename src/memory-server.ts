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
import { qdrantAvailable, searchByText, upsertText } from "./qdrant.js";

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

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
`;

// How many recent activity-feed events to keep around -- this is a live
// narration log for the dashboard, not an audit trail (that's actions/runs),
// so it's fine to trim it rather than grow it forever.
const EVENTS_KEEP = 500;

const now = () => new Date().toISOString();

export class MemoryStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // Vector search moved to Qdrant Cloud (qdrant.ts) -- vectors live there now,
    // keyed by the same row id, instead of inline as a JSON column here. Drops
    // the old Voyage-embedding column from a pre-migration DB if present
    // (node:sqlite's bundled SQLite supports DROP COLUMN); no-op on a fresh DB.
    this.dropColumnIfExists("research_notes", "embedding");
    this.dropColumnIfExists("lessons", "embedding");
    // Human-only verdict on an approved proposal's actual deliverable -- separate from
    // the model's self-reported outcome.success, and never settable by the model itself.
    this.ensureColumn("proposals", "review_status", "TEXT");

    // Priority + scheduling, all human-set at approval time (see decideProposal /
    // scheduleApprovedProposal) -- the model never controls when or how urgently a
    // real action runs. next_run_at is orchestrator-maintained: the scheduler polls
    // it, and it's what distinguishes "nothing pending" from "waiting for its turn."
    const addedPriority = this.ensureColumn("proposals", "priority", "TEXT NOT NULL DEFAULT 'normal'");
    this.ensureColumn("proposals", "scheduled_at", "TEXT");
    this.ensureColumn("proposals", "recurrence_ms", "INTEGER");
    this.ensureColumn("proposals", "next_run_at", "TEXT");
    if (addedPriority) {
      // One-time backfill for proposals approved before this migration existed --
      // otherwise they'd have next_run_at = NULL forever, which now means "nothing
      // pending" instead of "hasn't run yet." Harmless no-op against a fresh DB.
      this.db.exec(`
        UPDATE proposals SET next_run_at = datetime('now')
        WHERE status = 'approved'
          AND NOT EXISTS (SELECT 1 FROM actions WHERE actions.proposal_id = proposals.id AND actions.phase = 'act')
      `);
    }
  }

  /** Returns true if the column didn't already exist and was just added. */
  private ensureColumn(table: string, column: string, type: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((c) => c.name === column)) return false;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    return true;
  }

  private dropColumnIfExists(table: string, column: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }

  close() {
    this.db.close();
  }

  // ---- research ---------------------------------------------------------

  async addResearchNote(topic: string, finding: string, source?: string, confidence?: number) {
    const stmt = this.db.prepare(
      `INSERT INTO research_notes (topic, finding, source, confidence, fetched_at) VALUES (?, ?, ?, ?, ?)`
    );
    const result = stmt.run(topic, finding, source ?? null, confidence ?? null, now());
    const id = Number(result.lastInsertRowid);
    await upsertText("research_notes", id, `${topic}: ${finding}`);
    return id;
  }

  /** Semantic search via Qdrant when configured, falling back to LIKE otherwise. */
  async searchResearchNotes(topic: string, limit = 10) {
    const semantic = await this.semanticSearch<ResearchNoteRow>("research_notes", topic, limit);
    if (semantic) return semantic;

    const stmt = this.db.prepare(
      `SELECT * FROM research_notes WHERE topic LIKE ? OR finding LIKE ? ORDER BY fetched_at DESC LIMIT ?`
    );
    return stmt.all(`%${topic}%`, `%${topic}%`, limit) as unknown as ResearchNoteRow[];
  }

  listAllResearchNotes(limit = 200) {
    return this.db.prepare(`SELECT * FROM research_notes ORDER BY fetched_at DESC LIMIT ?`).all(limit) as unknown as ResearchNoteRow[];
  }

  /**
   * One-time backfill so rows inserted before Qdrant was configured (or under the old
   * inline-Voyage-embedding scheme) become semantically searchable too. Upserting an id
   * that's already present just overwrites the point, so this is safe to call on every
   * startup rather than tracking which rows still need it.
   */
  async syncToQdrant() {
    if (!qdrantAvailable) return;
    const notes = this.db.prepare(`SELECT id, topic, finding FROM research_notes`).all() as {
      id: number;
      topic: string;
      finding: string;
    }[];
    await Promise.all(notes.map((n) => upsertText("research_notes", n.id, `${n.topic}: ${n.finding}`)));

    const lessons = this.db.prepare(`SELECT id, domain, lesson FROM lessons`).all() as {
      id: number;
      domain: string;
      lesson: string;
    }[];
    await Promise.all(lessons.map((l) => upsertText("lessons", l.id, `${l.domain}: ${l.lesson}`)));
  }

  /** Ranks `table`'s rows by Qdrant vector similarity to `query`; null if Qdrant isn't configured or found nothing. */
  private async semanticSearch<T extends { id: number }>(
    table: "research_notes" | "lessons",
    query: string,
    limit: number
  ): Promise<T[] | null> {
    const hits = await searchByText(table, query, limit);
    if (!hits || hits.length === 0) return null;

    const placeholders = hits.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders})`).all(...hits.map((h) => h.id)) as T[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return hits.map((h) => byId.get(h.id)).filter((row): row is T => row !== undefined);
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

  /** Human-only verdict on whether an approved proposal's deliverable is MVP-done or needs more work. */
  setProposalReview(id: number, reviewStatus: "mvp_done" | "needs_refinement" | null) {
    this.db.prepare(`UPDATE proposals SET review_status = ? WHERE id = ?`).run(reviewStatus, id);
  }

  /** Called right after approval: sets the human-chosen priority/schedule and computes the first next_run_at. */
  scheduleApprovedProposal(
    id: number,
    opts: { priority: Priority; scheduledAt: string | null; recurrenceMs: number | null }
  ) {
    const nextRunAt = opts.scheduledAt ?? now();
    this.db
      .prepare(
        `UPDATE proposals SET priority = ?, scheduled_at = ?, recurrence_ms = ?, next_run_at = ? WHERE id = ?`
      )
      .run(opts.priority, opts.scheduledAt, opts.recurrenceMs, nextRunAt, id);
  }

  /** Approved proposals whose next_run_at has arrived, highest priority and earliest-due first. */
  listDueProposals(nowIso: string) {
    return this.db
      .prepare(
        `SELECT * FROM proposals
         WHERE status = 'approved' AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY CASE priority WHEN 'urgent' THEN 3 WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END DESC,
                  next_run_at ASC`
      )
      .all(nowIso) as unknown as ProposalRow[];
  }

  /** After a run completes: recurring proposals get rescheduled, one-shot proposals are cleared so they don't run again. */
  advanceOrClearSchedule(id: number, opts: { recurring: boolean; recurrenceMs: number | null }) {
    const nextRunAt = opts.recurring && opts.recurrenceMs ? new Date(Date.now() + opts.recurrenceMs).toISOString() : null;
    this.db.prepare(`UPDATE proposals SET next_run_at = ? WHERE id = ?`).run(nextRunAt, id);
  }

  /** Stops a scheduled/recurring proposal from running again, without touching its approval status. */
  cancelSchedule(id: number) {
    this.db.prepare(`UPDATE proposals SET next_run_at = NULL, recurrence_ms = NULL WHERE id = ?`).run(id);
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

  /** Every action taken on an approved proposal, across all its phases -- backs the Actions page. */
  listActionsForApprovedProposals(limit = 1000) {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.proposal_id, a.phase, a.tool_name, a.tool_input, a.tool_output, a.occurred_at,
                p.domain AS proposal_domain, p.description AS proposal_description
         FROM actions a JOIN proposals p ON p.id = a.proposal_id
         WHERE p.status = 'approved'
         ORDER BY a.occurred_at DESC LIMIT ?`
      )
      .all(limit) as unknown as ActionWithProposalRow[];
    return rows.map((r) => ({ ...r, result_url: extractResultUrl(r.tool_output) }));
  }

  /**
   * What's actually been done (act-phase, side-effecting tool calls only) on approved
   * proposals -- what the agent itself calls via action_history_search so research/plan
   * can check for existing work before proposing something that duplicates it.
   */
  listActionHistory(domain?: string, limit = 20) {
    const base = `SELECT a.tool_name, a.tool_input, a.tool_output, a.occurred_at, a.proposal_id,
                          p.domain, p.description AS proposal_description
                   FROM actions a JOIN proposals p ON p.id = a.proposal_id
                   WHERE p.status = 'approved' AND a.phase = 'act'`;
    const rows = (
      domain
        ? this.db.prepare(`${base} AND p.domain = ? ORDER BY a.occurred_at DESC LIMIT ?`).all(domain, limit)
        : this.db.prepare(`${base} ORDER BY a.occurred_at DESC LIMIT ?`).all(limit)
    ) as unknown as ActionHistoryRow[];

    return rows.map((r) => ({
      proposalId: r.proposal_id,
      domain: r.domain,
      proposalDescription: r.proposal_description,
      tool: r.tool_name.replace(/^mcp__(memory|integrations)__/, ""),
      input: safeParseJson(r.tool_input),
      resultUrl: extractResultUrl(r.tool_output),
      occurredAt: r.occurred_at,
    }));
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
    return this.db.prepare(`SELECT * FROM lessons ORDER BY updated_at DESC LIMIT ?`).all(limit) as unknown as LessonRow[];
  }

  /**
   * Semantic search over domain+lesson text when Qdrant is configured -- this is what
   * lets a lesson written for "VS Code extension for productivity" still surface for a
   * proposal in "VS Code extensions", where the old exact `domain = ?` match would miss
   * it. Falls back to exact domain equality (the original behavior) when Qdrant isn't
   * configured or the search failed.
   */
  async searchLessons(domain: string, limit = 10) {
    const semantic = await this.semanticSearch<LessonRow>("lessons", domain, limit);
    if (semantic) return semantic;

    return this.db
      .prepare(`SELECT * FROM lessons WHERE domain = ? ORDER BY confidence DESC, updated_at DESC LIMIT ?`)
      .all(domain, limit) as unknown as LessonRow[];
  }

  async addLesson(domain: string, lessonText: string, derivedFromOutcomeId?: number) {
    const stmt = this.db.prepare(
      `INSERT INTO lessons (domain, lesson, derived_from_outcome_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    );
    const t = now();
    const result = stmt.run(domain, lessonText, derivedFromOutcomeId ?? null, t, t);
    const id = Number(result.lastInsertRowid);
    await upsertText("lessons", id, `${domain}: ${lessonText}`);
    return id;
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
    return this.db.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`).all(limit) as unknown as RunRow[];
  }

  /** Every phase run charged to one proposal -- what it actually cost in Claude API spend, vs its estimate. */
  listRunsForProposal(proposalId: number) {
    return this.db
      .prepare(`SELECT * FROM runs WHERE proposal_id = ? ORDER BY started_at ASC`)
      .all(proposalId) as unknown as RunRow[];
  }

  totalRunCost(): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs`).get() as { total: number };
    return row.total;
  }

  // ---- events (persisted activity feed, so a page reload doesn't lose it) --

  logEvent(type: string, payload: unknown): { id: number; occurredAt: string } {
    const occurredAt = now();
    const result = this.db
      .prepare(`INSERT INTO events (type, payload, occurred_at) VALUES (?, ?, ?)`)
      .run(type, safeJson(payload), occurredAt);
    const id = Number(result.lastInsertRowid);
    this.db.prepare(`DELETE FROM events WHERE id <= ?`).run(id - EVENTS_KEEP);
    return { id, occurredAt };
  }

  listRecentEvents(limit = EVENTS_KEEP) {
    const rows = this.db
      .prepare(`SELECT id, payload, occurred_at FROM events ORDER BY id DESC LIMIT ?`)
      .all(limit) as { id: number; payload: string; occurred_at: string }[];
    return rows.reverse().map((r) => ({ id: r.id, occurredAt: r.occurred_at, event: JSON.parse(r.payload) as unknown }));
  }
}

interface ResearchNoteRow {
  id: number;
  topic: string;
  finding: string;
  source: string | null;
  confidence: number | null;
  fetched_at: string;
}

/** One phase run of the loop, with the Claude API cost it incurred -- spend counts against profit. */
interface RunRow {
  id: number;
  proposal_id: number | null;
  phase: string;
  cost_usd: number;
  duration_ms: number | null;
  started_at: string;
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
}

export type Priority = "low" | "normal" | "high" | "urgent";

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
  review_status: "mvp_done" | "needs_refinement" | null;
  priority: Priority;
  scheduled_at: string | null;
  recurrence_ms: number | null;
  next_run_at: string | null;
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function safeParseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Tool results that create/deploy something (github_create_repo, github_create_pr,
 * vercel_deploy, netlify_create_site, netlify_deploy) all return a plain `url` field.
 * tool_output is stored as the raw PostToolUse `tool_response` -- an MCP content-block
 * array whose text is itself a JSON-stringified result object -- so this unwraps both
 * layers and pulls `url` out generically rather than switching on tool name.
 */
function extractResultUrl(toolOutput: string | null): string | null {
  if (!toolOutput) return null;
  try {
    const content = JSON.parse(toolOutput) as { type?: string; text?: string }[];
    const text = Array.isArray(content) ? content.find((c) => c?.type === "text")?.text : undefined;
    if (!text) return null;
    const data = JSON.parse(text) as { url?: unknown };
    return typeof data?.url === "string" ? data.url : null;
  } catch {
    return null;
  }
}

interface ActionWithProposalRow {
  id: number;
  proposal_id: number;
  phase: string;
  tool_name: string;
  tool_input: string | null;
  tool_output: string | null;
  occurred_at: string;
  proposal_domain: string;
  proposal_description: string;
}

interface ActionHistoryRow {
  proposal_id: number;
  domain: string;
  proposal_description: string;
  tool_name: string;
  tool_input: string | null;
  tool_output: string | null;
  occurred_at: string;
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
      finding: z
        .string()
        .describe(
          "The distilled finding. One or two plain sentences for a simple fact. For anything with multiple " +
            "distinct parts, use Markdown instead of one dense paragraph: **bold** short labels and a '- ' " +
            "bullet list, one point per line."
        ),
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
      description: z
        .string()
        .describe(
          "What you'd do, specifically enough that a human can say yes or no. Format as Markdown, not one long " +
            "prose paragraph: a one-line **bold** headline (name + one-sentence pitch), a blank line, then a " +
            "'- ' bullet list of 3-6 short points -- whichever of what/why-now/differentiation/act-phase " +
            "scope/risks are relevant. Keep each bullet to one or two sentences."
        ),
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

  const actionHistorySearch = tool(
    "action_history_search",
    "See real-world actions already taken on approved proposals (repos created, sites deployed, files committed, etc.), optionally filtered to one domain. Call this before proposing new work so you don't duplicate something already built or deployed.",
    {
      domain: z.string().optional().describe("Filter to one domain; omit to see recent action history across all domains"),
      limit: z.number().int().positive().max(50).optional(),
    },
    async ({ domain, limit }) => {
      const rows = store.listActionHistory(domain, limit ?? 20);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
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
      actionHistorySearch,
    ],
  });
}
