// src/memory-server.ts
//
// A single SQLite database backs both:
//   1. the tool set the model calls itself (buildMemoryTools, at the bottom), and
//   2. a plain TypeScript class (MemoryStore) the orchestrator calls directly
//      for things the agent should never control, e.g. reading pending
//      proposals for human review, or recording the human's decision.
//
// Split like that on purpose: the agent gets read/write access to research,
// lessons, and its own proposals. It never gets a tool that approves its own
// spending, and it never gets a tool that logs actions on its own tool calls
// -- those are recorded by agent-loop.ts around every dispatch, so the audit
// trail can't be skipped by the model forgetting to call a "log this" tool.

import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { defineTool, namespaceTools, type ToolDefinition } from "./tools/registry.js";
import { emitAgentEvent } from "./events.js";
import { deletePoint, qdrantAvailable, searchByText, upsertText } from "./qdrant.js";
// tool_output has carried two storage shapes across this project's life and both are
// still in the DB; tool-output.ts is the single place that knows how to read either.
import { extractResultUrl } from "./tool-output.js";
import { DELIVERABLE_TOOLS, type DeliverableActionRow } from "./deliverables.js";

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
  actual_cost REAL NOT NULL DEFAULT 0,    -- include model API spend, not just external cost
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

-- Operator settings made from the console (agent-control.ts), which used to live only in
-- process memory: retuning the domains in the UI looked permanent and then silently reverted
-- to AGENT_DOMAINS on the next restart. Values are JSON so one table covers every knob.
CREATE TABLE IF NOT EXISTS control_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
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

    // Human curation of the agent's own memory. A lesson the model got wrong would
    // otherwise be lesson_search-ed into every future cycle forever, with no way to
    // take it back -- muting excludes it from search without destroying the record of
    // what was believed and when. Never settable by the model: there is no MCP tool
    // for any of this, same reasoning as proposal approval.
    this.ensureColumn("lessons", "muted", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("lessons", "edited_at", "TEXT");

    // Set only when a human narrowed or widened a proposal's scope at approval time.
    // required_tools stays the single thing actPhase is fenced to; these columns preserve
    // what the model originally asked for, so an edited fence is auditable after the fact
    // rather than looking like what the model proposed all along.
    this.ensureColumn("proposals", "original_required_tools", "TEXT");
    this.ensureColumn("proposals", "original_description", "TEXT");

    // Which model produced each run. Nullable rather than backfilled: runs recorded
    // before this project left the Claude Agent SDK genuinely have no answer, and
    // inventing one would misattribute their spend.
    this.ensureColumn("runs", "provider", "TEXT");
    this.ensureColumn("runs", "model", "TEXT");

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

  async deleteResearchNote(id: number) {
    this.db.prepare(`DELETE FROM research_notes WHERE id = ?`).run(id);
    await deletePoint("research_notes", id);
  }

  /**
   * Folds duplicate notes into `keepId`: any source URL the duplicates had that the keeper
   * lacked is appended to the keeper's finding (so merging never silently drops a citation),
   * then the duplicates are deleted.
   */
  async mergeResearchNotes(keepId: number, mergeIds: number[]) {
    const keeper = this.db.prepare(`SELECT * FROM research_notes WHERE id = ?`).get(keepId) as
      | ResearchNoteRow
      | undefined;
    if (!keeper) return false;

    const ids = mergeIds.filter((id) => id !== keepId);
    if (ids.length === 0) return true;

    const placeholders = ids.map(() => "?").join(",");
    const others = this.db
      .prepare(`SELECT * FROM research_notes WHERE id IN (${placeholders})`)
      .all(...ids) as unknown as ResearchNoteRow[];

    const extraSources = [
      ...new Set(others.map((o) => o.source).filter((s): s is string => Boolean(s) && s !== keeper.source)),
    ];
    const finding = extraSources.length > 0 ? `${keeper.finding}\n\nAlso sourced from: ${extraSources.join(", ")}` : keeper.finding;
    // Keep the highest confidence any of the merged notes claimed rather than the keeper's alone.
    const confidence = [keeper, ...others].reduce<number | null>(
      (max, n) => (n.confidence != null && (max == null || n.confidence > max) ? n.confidence : max),
      null
    );

    this.db
      .prepare(`UPDATE research_notes SET finding = ?, confidence = ? WHERE id = ?`)
      .run(finding, confidence, keepId);
    this.db.prepare(`DELETE FROM research_notes WHERE id IN (${placeholders})`).run(...ids);

    await upsertText("research_notes", keepId, `${keeper.topic}: ${finding}`);
    await Promise.all(others.map((o) => deletePoint("research_notes", o.id)));
    return true;
  }

  /**
   * Near-duplicate note pairs, by word-overlap (Jaccard) on topic+finding. Deliberately not a
   * Qdrant query: that would be one round trip per note to compare all pairs, where this is a
   * local scan over a few hundred rows and returns the same shape of answer deterministically
   * whether or not Qdrant is configured.
   */
  findDuplicateResearchNotes(threshold = 0.6, limit = 50) {
    const notes = this.listAllResearchNotes(500);
    const tokenized = notes.map((n) => ({ note: n, tokens: tokenSet(`${n.topic} ${n.finding}`) }));

    const pairs: { a: ResearchNoteRow; b: ResearchNoteRow; similarity: number }[] = [];
    for (let i = 0; i < tokenized.length; i++) {
      for (let j = i + 1; j < tokenized.length; j++) {
        const similarity = jaccard(tokenized[i].tokens, tokenized[j].tokens);
        if (similarity >= threshold) {
          pairs.push({ a: tokenized[i].note, b: tokenized[j].note, similarity });
        }
      }
    }
    return pairs.sort((x, y) => y.similarity - x.similarity).slice(0, limit);
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

  /**
   * Applies a human's edits to a proposal's scope at approval time, preserving what the model
   * originally proposed. Only ever called from the decision endpoint, before the proposal is
   * approved -- an approved proposal's fence is never edited afterwards.
   */
  /**
   * Whether an act phase has already run for this proposal. The dividing line for
   * whether its scope can still be edited: once the model has committed or deployed
   * something, narrowing required_tools can't un-do it, and widening would authorise
   * work retroactively.
   */
  hasActed(id: number): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS found FROM actions WHERE proposal_id = ? AND phase = 'act' LIMIT 1`)
      .get(id) as { found: number } | undefined;
    return Boolean(row);
  }

  applyProposalEdits(id: number, edits: { description?: string; requiredTools?: string[] }) {
    const existing = this.getProposal(id);
    if (!existing) return false;

    if (edits.description !== undefined && edits.description !== existing.description) {
      this.db
        .prepare(
          `UPDATE proposals SET description = ?,
             original_description = COALESCE(original_description, ?) WHERE id = ?`
        )
        .run(edits.description, existing.description, id);
    }
    if (edits.requiredTools !== undefined) {
      const next = edits.requiredTools.join(",");
      if (next !== existing.required_tools) {
        this.db
          .prepare(
            `UPDATE proposals SET required_tools = ?,
               original_required_tools = COALESCE(original_required_tools, ?) WHERE id = ?`
          )
          .run(next, existing.required_tools, id);
      }
    }
    return true;
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
   * The act-phase calls that can produce a browsable artifact -- what buildDeliverables
   * turns into the Deliverables page. Narrowed to those tool names in SQL rather than
   * filtered in JS because the rows this skips are the fat ones: a WebFetch of a whole
   * page, or a research note's full text, none of which can name a repo or a deployment.
   */
  listDeliverableActions(): DeliverableActionRow[] {
    const tools = DELIVERABLE_TOOLS.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT a.id, a.proposal_id, a.tool_name, a.tool_input, a.tool_output, a.occurred_at
         FROM actions a JOIN proposals p ON p.id = a.proposal_id
         WHERE p.status = 'approved' AND a.phase = 'act' AND a.tool_name IN (${tools})
         ORDER BY a.occurred_at ASC`
      )
      .all(...DELIVERABLE_TOOLS) as unknown as DeliverableActionRow[];
  }

  /** Act-phase calls per approved proposal -- the full trail size behind each deliverable. */
  actActionCounts(): Map<number, number> {
    const rows = this.db
      .prepare(
        `SELECT a.proposal_id, COUNT(*) AS n
         FROM actions a JOIN proposals p ON p.id = a.proposal_id
         WHERE p.status = 'approved' AND a.phase = 'act'
         GROUP BY a.proposal_id`
      )
      .all() as unknown as { proposal_id: number; n: number }[];
    return new Map(rows.map((r) => [r.proposal_id, r.n]));
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
    // Muted lessons are filtered out of both paths -- this is the single chokepoint every
    // lesson_search call goes through, so muting one here takes it out of the agent's
    // reasoning everywhere at once.
    // Over-fetch so muting a few of the top hits doesn't quietly shrink the result set.
    const semantic = await this.semanticSearch<LessonRow>("lessons", domain, limit * 2);
    if (semantic) return semantic.filter((l) => !l.muted).slice(0, limit);

    return this.db
      .prepare(
        `SELECT * FROM lessons WHERE domain = ? AND muted = 0 ORDER BY confidence DESC, updated_at DESC LIMIT ?`
      )
      .all(domain, limit) as unknown as LessonRow[];
  }

  /**
   * Free-text lesson search for the console's operator, as distinct from searchLessons above:
   * that one's LIKE fallback matches `domain` exactly, which is right for the agent (it looks
   * lessons up by the domain it's working in) but useless for a human typing a phrase from the
   * lesson body. Same semantic path, same muted filter -- only the fallback differs.
   */
  async searchLessonsByText(query: string, limit = 10) {
    const semantic = await this.semanticSearch<LessonRow>("lessons", query, limit * 2);
    if (semantic) return semantic.filter((l) => !l.muted).slice(0, limit);

    const like = `%${query}%`;
    return this.db
      .prepare(
        `SELECT * FROM lessons WHERE muted = 0 AND (domain LIKE ? OR lesson LIKE ?)
         ORDER BY confidence DESC, updated_at DESC LIMIT ?`
      )
      .all(like, like, limit) as unknown as LessonRow[];
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

  // ---- lesson curation (human-only -- no MCP tool exposes any of this) ----

  getLesson(id: number) {
    return this.db.prepare(`SELECT * FROM lessons WHERE id = ?`).get(id) as LessonRow | undefined;
  }

  /** Rewrite a lesson the model got wrong or phrased badly, keeping its id and track record. */
  async editLesson(id: number, fields: { domain?: string; lesson?: string }) {
    const existing = this.getLesson(id);
    if (!existing) return false;
    const domain = fields.domain ?? existing.domain;
    const lessonText = fields.lesson ?? existing.lesson;
    this.db
      .prepare(`UPDATE lessons SET domain = ?, lesson = ?, updated_at = ?, edited_at = ? WHERE id = ?`)
      .run(domain, lessonText, now(), now(), id);
    // Keep the vector in step with the text, or semantic search would keep matching the old wording.
    await upsertText("lessons", id, `${domain}: ${lessonText}`);
    return true;
  }

  /**
   * Excludes a lesson from lesson_search without deleting it -- the row stays as a record of
   * what was believed and when, but it stops steering future cycles.
   */
  setLessonMuted(id: number, muted: boolean) {
    this.db.prepare(`UPDATE lessons SET muted = ?, updated_at = ? WHERE id = ?`).run(muted ? 1 : 0, now(), id);
  }

  async deleteLesson(id: number) {
    this.db.prepare(`DELETE FROM lessons WHERE id = ?`).run(id);
    await deletePoint("lessons", id);
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

  // ---- runs (model API cost per phase, so spend counts against profit) --

  logRun(
    proposalId: number | null,
    phase: string,
    costUsd: number,
    durationMs: number | undefined,
    startedAt: string,
    // Recorded per run because phases can be pointed at different models
    // (AGENT_ACT_MODEL and friends) -- without this a cost difference between two
    // phases is unattributable on the Economics page.
    provider?: string,
    model?: string
  ) {
    this.db
      .prepare(
        `INSERT INTO runs (proposal_id, phase, cost_usd, duration_ms, started_at, provider, model)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(proposalId, phase, costUsd, durationMs ?? null, startedAt, provider ?? null, model ?? null);
  }

  listRuns(limit = 200) {
    return this.db.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`).all(limit) as unknown as RunRow[];
  }

  /** Every phase run charged to one proposal -- what it actually cost in model API spend, vs its estimate. */
  listRunsForProposal(proposalId: number) {
    return this.db
      .prepare(`SELECT * FROM runs WHERE proposal_id = ? ORDER BY started_at ASC`)
      .all(proposalId) as unknown as RunRow[];
  }

  totalRunCost(): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs`).get() as { total: number };
    return row.total;
  }

  // ---- operator control settings -------------------------------------------
  //
  // Not model-callable, and deliberately not part of buildMemoryTools(): these are the
  // operator's knobs. The agent must not be able to widen its own domains, unpause itself
  // or write its own directive, so they live here as plain methods the orchestrator and
  // server.ts call, exactly like proposal approval does.

  loadControlSettings(): PersistedControl {
    const rows = this.db.prepare(`SELECT key, value FROM control_settings`).all() as unknown as {
      key: string;
      value: string;
    }[];
    const out: PersistedControl = {};
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        // A hand-edited or truncated row shouldn't stop the loop from starting -- the
        // env default takes over for that key, which is the same state as never having
        // set it from the console.
        console.warn(`[control] ignoring unparseable setting "${row.key}"`);
        continue;
      }
      if (row.key === "domains" && Array.isArray(parsed) && parsed.every((d) => typeof d === "string")) {
        out.domains = parsed;
      } else if (row.key === "cycleIntervalMs" && typeof parsed === "number" && Number.isFinite(parsed)) {
        out.cycleIntervalMs = parsed;
      } else if (row.key === "paused" && typeof parsed === "boolean") {
        out.paused = parsed;
      } else if (row.key === "directive" && (parsed === null || typeof parsed === "string")) {
        out.directive = parsed;
      }
    }
    return out;
  }

  /** Upserts each key present in the patch; `directive: null` clears it (a consumed directive). */
  saveControlSettings(patch: PersistedControl): void {
    const stmt = this.db.prepare(
      `INSERT INTO control_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    const at = now();
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      stmt.run(key, JSON.stringify(value), at);
    }
  }

  // ---- economics ----------------------------------------------------------
  //
  // The loop's whole premise is that spend counts against profit, so these join
  // model API spend (runs) to self-reported outcomes rather than reporting either
  // in isolation. `net` is the only number that answers "is this thing paying for
  // itself": revenue minus the agent's own reported cost minus what it cost in API
  // spend to produce.
  //
  // The console has to be able to show *where* a total came from, not just the total:
  // `runs` accumulates across provider switches and across rows written before
  // `provider`/`model` were recorded at all, so a lifetime figure on its own is a
  // number nobody can reconcile. `spendByModel` and `unattributedSpend` exist so the
  // headline decomposes into parts that add back up to it.

  spendByPhase() {
    return this.db
      .prepare(
        `SELECT phase, COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS cost_usd,
                COALESCE(SUM(duration_ms), 0) AS duration_ms
         FROM runs GROUP BY phase ORDER BY cost_usd DESC`
      )
      .all() as unknown as { phase: string; runs: number; cost_usd: number; duration_ms: number }[];
  }

  /**
   * Spend split by the provider/model that produced it. `provider`/`model` are nullable --
   * rows written before those columns existed have neither, and they are reported as their own
   * bucket rather than folded into whatever is configured now, which would misattribute an
   * earlier provider's spend to the current one.
   */
  spendByModel() {
    return this.db
      .prepare(
        `SELECT provider, model, COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS cost_usd,
                MIN(started_at) AS first_at, MAX(started_at) AS last_at
         FROM runs GROUP BY provider, model ORDER BY cost_usd DESC`
      )
      .all() as unknown as ModelSpendRow[];
  }

  /**
   * Spend on runs charged to no proposal -- research/plan cycles, which run before anything
   * has been proposed. It is usually most of the total, and it is exactly the gap between the
   * domain scoreboard's `api_spend` column (which can only see runs that have a proposal) and
   * the lifetime figure, so the console can state the difference instead of leaving it as an
   * unexplained shortfall.
   */
  unattributedSpend(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE proposal_id IS NULL`)
      .get() as { total: number };
    return row.total;
  }

  /** Daily model API spend, oldest first -- the series behind the spend-over-time chart. */
  spendOverTime(days = 30) {
    return this.db
      .prepare(
        `SELECT substr(started_at, 1, 10) AS day, COALESCE(SUM(cost_usd), 0) AS cost_usd, COUNT(*) AS runs
         FROM runs GROUP BY day ORDER BY day DESC LIMIT ?`
      )
      .all(days)
      .reverse() as unknown as { day: string; cost_usd: number; runs: number }[];
  }

  /**
   * Per-domain scoreboard: how often work in a domain succeeded, what it really cost, and how
   * far the model's own upside estimate landed from reported revenue (forecast accuracy --
   * both numbers were already stored, just never compared).
   */
  domainScoreboard() {
    return this.db
      .prepare(
        `SELECT p.domain,
                COUNT(DISTINCT p.id) AS proposals,
                COUNT(DISTINCT CASE WHEN p.status = 'approved' THEN p.id END) AS approved,
                COUNT(DISTINCT o.id) AS outcomes,
                COALESCE(SUM(CASE WHEN o.success = 1 THEN 1 ELSE 0 END), 0) AS successes,
                COALESCE(SUM(o.actual_revenue), 0) AS revenue,
                COALESCE(SUM(o.actual_cost), 0) AS reported_cost,
                COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN p.expected_upside ELSE 0 END), 0) AS forecast_upside,
                (SELECT COALESCE(SUM(r.cost_usd), 0) FROM runs r
                  JOIN proposals rp ON rp.id = r.proposal_id WHERE rp.domain = p.domain) AS api_spend
         FROM proposals p
         LEFT JOIN outcomes o ON o.proposal_id = p.id
         GROUP BY p.domain
         ORDER BY revenue DESC`
      )
      .all() as unknown as DomainScoreRow[];
  }

  // ---- unified search (backs the console's global search) ------------------

  /**
   * One query across everything the console can navigate to. Lessons and research notes go
   * through the same Qdrant-or-LIKE path the agent's own tools use, so the operator searches
   * the memory the way the agent reads it -- semantically when Qdrant is configured, by
   * substring when it isn't. Proposals and actions have no vectors, so they stay LIKE-matched.
   */
  async searchEverything(query: string, perTypeLimit = 5): Promise<SearchHit[]> {
    const like = `%${query}%`;
    const hits: SearchHit[] = [];

    const proposals = this.db
      .prepare(
        `SELECT id, domain, description, status FROM proposals
         WHERE domain LIKE ? OR description LIKE ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(like, like, perTypeLimit) as unknown as {
      id: number;
      domain: string;
      description: string;
      status: string;
    }[];
    for (const p of proposals) {
      hits.push({ type: "proposal", id: p.id, title: `#${p.id} · ${p.domain}`, snippet: p.description, badge: p.status });
    }

    for (const lesson of await this.searchLessonsByText(query, perTypeLimit)) {
      hits.push({ type: "lesson", id: lesson.id, title: lesson.domain, snippet: lesson.lesson });
    }

    for (const note of await this.searchResearchNotes(query, perTypeLimit)) {
      hits.push({ type: "research_note", id: note.id, title: note.topic, snippet: note.finding });
    }

    const actions = this.db
      .prepare(
        `SELECT a.id, a.proposal_id, a.tool_name, a.tool_input FROM actions a
         JOIN proposals p ON p.id = a.proposal_id
         WHERE p.status = 'approved' AND (a.tool_name LIKE ? OR a.tool_input LIKE ?)
         ORDER BY a.occurred_at DESC LIMIT ?`
      )
      .all(like, like, perTypeLimit) as unknown as {
      id: number;
      proposal_id: number;
      tool_name: string;
      tool_input: string | null;
    }[];
    for (const a of actions) {
      hits.push({
        type: "action",
        id: a.id,
        proposalId: a.proposal_id,
        title: a.tool_name.replace(/^mcp__(memory|integrations)__/, ""),
        snippet: (a.tool_input ?? "").slice(0, 200),
      });
    }

    return hits;
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

export interface SearchHit {
  type: "proposal" | "lesson" | "research_note" | "action";
  id: number;
  title: string;
  snippet: string;
  badge?: string;
  /** Set on action hits -- the Actions page navigates by proposal, not by action id. */
  proposalId?: number;
}

export interface DomainScoreRow {
  domain: string;
  proposals: number;
  approved: number;
  outcomes: number;
  successes: number;
  revenue: number;
  reported_cost: number;
  /** Sum of expected_upside across proposals that actually produced an outcome -- compare to `revenue`. */
  forecast_upside: number;
  api_spend: number;
}

/**
 * The operator-set half of `ControlState`. Every field is optional: an absent key means the
 * console never set it, and the env default applies. The runtime-only parts of `ControlState`
 * (what's currently executing) are not here -- they describe this process, not a preference.
 */
export interface PersistedControl {
  domains?: string[];
  cycleIntervalMs?: number;
  paused?: boolean;
  directive?: string | null;
}

/**
 * Lifetime spend on one provider/model pair. Both are null for runs recorded before the
 * columns existed, which the console labels rather than silently attributing to the current
 * provider.
 */
export interface ModelSpendRow {
  provider: string | null;
  model: string | null;
  runs: number;
  cost_usd: number;
  first_at: string;
  last_at: string;
}

/** One phase run of the loop, with the model API cost it incurred -- spend counts against profit. */
interface RunRow {
  id: number;
  proposal_id: number | null;
  phase: string;
  cost_usd: number;
  duration_ms: number | null;
  started_at: string;
  /** Null on runs recorded before phases could use different models. */
  provider: string | null;
  model: string | null;
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
  /** 1 = excluded from lesson_search. Human-set only; the model can't mute or unmute itself. */
  muted: number;
  /** Set when a human rewrote the text, so an edited lesson is distinguishable from a model-written one. */
  edited_at: string | null;
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
  /** Set only when a human edited the scope at approval time -- what the model originally asked for. */
  original_required_tools: string | null;
  original_description: string | null;
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Lowercased word set, minus very short filler tokens -- the unit of comparison for near-duplicate notes. */
function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

function safeParseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
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

// ---- tool definitions ---------------------------------------------------
//
// These are the only memory operations the agent itself can call. Notice
// what's absent: no tool to approve a proposal, no tool to mark itself
// successful, no tool that touches real money. Those stay in the
// orchestrator's hands.
//
// The `mcp__memory__` prefix is a namespace, not a live MCP server -- see the
// note in tools/registry.ts for why the persisted names kept it.

export function buildMemoryTools(store: MemoryStore): ToolDefinition[] {
  const researchNoteAdd = defineTool(
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
      return `Saved research note #${id}`;
    }
  );

  const researchNoteSearch = defineTool(
    "research_note_search",
    "Check what has already been researched on a topic before spending a web search cycle re-discovering it.",
    { topic: z.string(), limit: z.number().int().positive().max(50).optional() },
    async ({ topic, limit }) => {
      const rows = await store.searchResearchNotes(topic, limit ?? 10);
      return JSON.stringify(rows, null, 2);
    }
  );

  const lessonSearch = defineTool(
    "lesson_search",
    "Retrieve lessons learned from past attempts in a domain, ranked by confidence. Call this before proposing or planning anything.",
    { domain: z.string(), limit: z.number().int().positive().max(50).optional() },
    async ({ domain, limit }) => {
      const rows = await store.searchLessons(domain, limit ?? 10);
      return JSON.stringify(rows, null, 2);
    }
  );

  const lessonAdd = defineTool(
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
      return `Saved lesson #${id}`;
    }
  );

  const lessonReinforce = defineTool(
    "lesson_reinforce",
    "Adjust an existing lesson's confidence instead of creating a duplicate, when a new outcome confirms or contradicts it.",
    { id: z.number().int(), direction: z.enum(["confirmed", "contradicted"]) },
    async ({ id, direction }) => {
      store.reinforceLesson(id, direction);
      return `Lesson #${id} marked ${direction}`;
    }
  );

  const proposalCreate = defineTool(
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
      return `Created proposal #${id}, status: pending. Stop here and wait for review -- do not act on it.`;
    }
  );

  const actionHistorySearch = defineTool(
    "action_history_search",
    "See real-world actions already taken on approved proposals (repos created, sites deployed, files committed, etc.), optionally filtered to one domain. Call this before proposing new work so you don't duplicate something already built or deployed.",
    {
      domain: z.string().optional().describe("Filter to one domain; omit to see recent action history across all domains"),
      limit: z.number().int().positive().max(50).optional(),
    },
    async ({ domain, limit }) => {
      const rows = store.listActionHistory(domain, limit ?? 20);
      return JSON.stringify(rows, null, 2);
    }
  );

  const proposalStatus = defineTool(
    "proposal_status",
    "Check whether a previously created proposal has been approved, rejected, or is still pending.",
    { id: z.number().int() },
    async ({ id }) => {
      const row = store.getProposal(id);
      if (!row) return "No such proposal";
      return JSON.stringify(row, null, 2);
    }
  );

  const outcomeRecord = defineTool(
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
      return `Recorded outcome #${id}`;
    }
  );

  return namespaceTools("mcp__memory__", [
    researchNoteAdd,
    researchNoteSearch,
    lessonSearch,
    lessonAdd,
    lessonReinforce,
    proposalCreate,
    proposalStatus,
    outcomeRecord,
    actionHistorySearch,
  ]);
}
