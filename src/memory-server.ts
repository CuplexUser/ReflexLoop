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
import {
  andFilters,
  deletePoint,
  goalFilter,
  kindFilter,
  notMutedFilter,
  qdrantAvailable,
  recommendByText,
  searchByText,
  setPayload,
  upsertMany,
  upsertText,
  type CollectionName,
  type QdrantPoint,
  type SearchOptions,
} from "./qdrant.js";
// tool_output has carried two storage shapes across this project's life and both are
// still in the DB; tool-output.ts is the single place that knows how to read either.
import { extractResultUrl } from "./tool-output.js";
import { DELIVERABLE_TOOLS, type DeliverableActionRow } from "./deliverables.js";
import { findNearDuplicate, similarity, terms } from "./proposal-similarity.js";

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

-- What the agent is pointed at. Replaces the free-text "domain" string as the thing the
-- operator curates, because that string was doing two incompatible jobs at once: a stable
-- grouping key AND a research brief. It could not do both. The model invents the domain on
-- every proposal_create and nothing validated it, so 20 proposals arrived under 13 distinct
-- spellings ("comparison site / affiliate", "affiliate comparison site", "comparison
-- directory affiliate site" -- one idea, three keys), which silently broke every exact-match
-- lookup built on it: action_history_search returned nothing, the scoreboard fragmented, and
-- the lesson fallback reached zero rows.
--
-- Splitting title from brief is the fix for the second job: the brief is where "research in
-- Swedish, check Fortnox/Bokio first" belongs, instead of being crammed into the key.
--
-- status='suggested' is how the agent proposes a new direction (goal_suggest). A suggested
-- goal is inert -- never in getControlState().domains, never in a prompt, never researched --
-- until a human accepts it. Same invariant as proposals, one level up: the agent may point at
-- a direction, only the operator makes it real.
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,                       -- short, stable, operator-facing; the grouping key
  brief TEXT NOT NULL DEFAULT '',            -- the long instructions, kept out of the key
  status TEXT NOT NULL DEFAULT 'active',     -- active | paused | retired | suggested
  weight REAL NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'human',      -- human | agent
  parent_id INTEGER REFERENCES goals(id),    -- set when this goal is a branch off another
  rationale TEXT,                            -- why the agent suggested it
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

// How many recent activity-feed events to keep around -- this is a live
// narration log for the dashboard, not an audit trail (that's actions/runs),
// so it's fine to trim it rather than grow it forever.
const EVENTS_KEEP = 500;

/**
 * How close a free-text label has to be to a goal's title before a row is filed under it.
 *
 * Asymmetric costs drive the value: a miss leaves the row unassigned, which is exactly where
 * every pre-goals row already sits and still reachable by text search, while a false match files
 * work under the wrong lane and puts a number on the scoreboard that isn't true. So this errs
 * high. At 0.6, "free web-based tool or calculator people search for and use directly
 * in-browser" still resolves to the goal seeded from it (0.9), while "micro-SaaS tool for
 * developers" -- which has no honest answer among the current goals -- resolves to none.
 */
const GOAL_MATCH_THRESHOLD = 0.6;

/**
 * Bumped whenever what gets *stored* in Qdrant changes -- the collection shape, the payload
 * fields, or the text that gets embedded. A mismatch against the recorded marker forces a full
 * re-sync instead of an incremental one, which is the only way points written under an older
 * scheme get brought up to date.
 */
const QDRANT_SYNC_VERSION = 2;

/** How many points go in one upsert request. Large enough to matter, small enough to stay well under any body limit. */
const QDRANT_BATCH = 64;

/**
 * How many dead ends steer one exploration query. Small on purpose: `best_score` scores a
 * candidate as its best positive similarity minus its best negative one, so every extra negative
 * can only push scores down. Feed it the whole saturation history and the negative term wins
 * outright -- measured, that returned the same four notes for all four goals.
 */
const EXPLORE_NEGATIVES = 5;

/**
 * Where "this is the thing we already wrote" starts, as raw cosine similarity.
 *
 * Measured over the real store rather than picked round -- and measured *dense-only*, because
 * under hybrid fusion the top hit scores 1.0 by virtue of ranking first, whatever it actually
 * resembles. What the numbers say:
 *
 *   lessons   0.783  #1 credential-check lesson   x #2 credential-check lesson   <- duplicates,
 *                                                    written 50 seconds apart into two domains
 *             ---- 0.70 ----
 *             0.577  #2 credentials               x #4 name the deployment gap
 *             0.352  #3 SSO wall                  x #4 name the deployment gap
 *
 *   notes     0.863  #47 Swedish skatteplanering  x #49 Swedish skatteplanering  <- duplicates
 *             ---- 0.85 ----
 *             0.842  #3  VS Code monetization     x #12 VS Code monetization constraint
 *             0.832  #15 Actions cost landscape   x #18 Actions cost competitive check
 *
 * Lessons get the lower bar: they're injected into prompts, a duplicate there costs context on
 * every cycle, and `lesson_reinforce` is a first-class alternative the model is told to use. The
 * gap under them is wide (0.783 vs 0.577), so 0.70 is not a close call.
 *
 * Notes get the higher bar and it *is* a close call -- 0.021 between the true duplicate and a
 * pair that only looks like one. Erring high is the right side to err on: notes are cheap to
 * hold, there's already a human-driven merge flow for them, and the refusal is recoverable
 * either way. If you retune these, re-measure against the real DB rather than nudging them.
 */
const LESSON_DUPLICATE_THRESHOLD = 0.7;
const NOTE_DUPLICATE_THRESHOLD = 0.85;

/**
 * The same question asked lexically, for when Qdrant is unavailable. A different scale entirely
 * (Jaccard over stems, not cosine over embeddings), so it gets its own number rather than
 * borrowing one of the two above.
 */
const LEXICAL_DUPLICATE_THRESHOLD = 0.5;

// The exact text each row is embedded as. Kept in one place per type because every write path
// (insert, edit, merge, full re-sync) has to agree: if two of them format differently, a row's
// vector stops matching its own text the first time it's edited.
const noteEmbeddingText = (topic: string, finding: string) => `${topic}: ${finding}`;
const lessonEmbeddingText = (domain: string, lesson: string) => `${domain}: ${lesson}`;

/** Sequential batches, not Promise.all over all of them: a full rebuild shouldn't burst the cluster. */
async function upsertInBatches(collection: CollectionName, points: QdrantPoint[]): Promise<void> {
  for (let i = 0; i < points.length; i += QDRANT_BATCH) {
    await upsertMany(collection, points.slice(i, i + QDRANT_BATCH));
  }
}

const now = () => new Date().toISOString();

export class MemoryStore {
  private db: DatabaseSync;

  /**
   * `readOnly` opens the file so SQLite itself rejects every write -- used by the
   * console-only dev mode (see console-mode.ts), where the point is to look at the real
   * database without any chance of changing it. The schema statements below still run:
   * `CREATE ... IF NOT EXISTS` is a no-op on an existing object even read-only, and the
   * migrations check `PRAGMA table_info` before altering anything. A DB that genuinely
   * needs a migration will throw here, which is correct -- migrating is a write, so it
   * has to happen in a normal run first.
   *
   * That throw is caught and re-labelled rather than left raw. It had never actually fired
   * (no migration had been added since console-only mode existed), and what it produces
   * unhandled is `Error: attempt to write a readonly database` over a stack trace, which
   * tells an operator nothing about what to do. The answer is always the same one line.
   */
  constructor(path: string, { readOnly = false }: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, { readOnly });
    try {
      this.migrate();
    } catch (err) {
      if (readOnly) {
        throw new Error(
          `${path} needs a schema migration, which read-only console mode can't perform. ` +
            `Run \`npm start\` once to migrate it, then \`npm run start:console\` again. (${String(err)})`
        );
      }
      throw err;
    }
  }

  /** Schema + every additive migration. Idempotent: re-running it on a current DB does nothing. */
  private migrate() {
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

    // Which goal a row belongs to. Nullable and deliberately not backfilled: rows written
    // before goals existed carry one of 13 free-text domain spellings, and mapping those onto
    // goals would be guessing. They stay NULL and group as "unassigned".
    //
    // This is why goal_id is for *attribution* only (scoreboard, per-goal health, filters) and
    // recall is semantic instead: searching on the goal's title+brief reaches history written
    // under any of the old spellings, so nothing has to be migrated for the agent to remember
    // what it already learned. The two mechanisms answer different questions on purpose.
    this.ensureColumn("proposals", "goal_id", "INTEGER REFERENCES goals(id)");
    this.ensureColumn("lessons", "goal_id", "INTEGER REFERENCES goals(id)");
    this.ensureColumn("research_notes", "goal_id", "INTEGER REFERENCES goals(id)");
    this.ensureColumn("runs", "goal_id", "INTEGER REFERENCES goals(id)");

    // What kind of finding a note is. ~17 of the first 46 notes were "I checked, it's
    // saturated" -- knowledge that is useful as a *negative* filter ("don't re-check these"),
    // not as positive context, a distinction the store previously could not express. NULL
    // means unclassified (every pre-existing row) and is simply excluded from the negatives.
    this.ensureColumn("research_notes", "kind", "TEXT");

    // How a proposal is supposed to make money, and what stands between approval and the
    // first dollar. Until now the only structured money field was `expected_upside` -- a
    // bare number -- so the mechanism, the buyer, the price and the steps lived in prose
    // inside `description`, whose format spec didn't even list the money path among its
    // suggested bullets. The review decision is the one irreversible human act in the loop
    // and it was being made without the thing it most needs.
    //
    // All three are nullable and not backfilled: a proposal written before these existed
    // may well have said all of it in prose, but parsing that back out would be guessing,
    // and the console simply renders no section for a row that has none. Same stance as
    // goal_id above.
    this.ensureColumn("proposals", "revenue_model", "TEXT");
    this.ensureColumn("proposals", "monetization_json", "TEXT");
    this.ensureColumn("proposals", "steps_json", "TEXT");

    // Whether the approved work actually got done. See ActStatus for the states and why this
    // is a stored column rather than derived from `actions` the way deliverables.ts is: the
    // verdict depends on the model's finish reason, which no table records, and the state that
    // matters most -- an act phase the process died in the middle of -- is precisely the one
    // with no completion row to derive from.
    //
    // NULL on every proposal that has never acted, including all pre-existing ones, which is
    // the correct reading for them rather than a backfill guess.
    this.ensureColumn("proposals", "act_status", "TEXT");
    this.ensureColumn("proposals", "act_problems", "TEXT");
  }

  /**
   * Clears the `running` act marker left behind by a process that died mid-phase.
   *
   * Safe as an unconditional startup sweep because act phases only ever run in the
   * orchestrator process, one at a time: if this process is only starting now, nothing
   * is running, so every `running` row is a corpse. Distinguishing the two matters --
   * `running` means "in flight, don't touch", `interrupted` means "nobody is coming
   * back for this", and they get opposite treatment in the duplicate check.
   *
   * Returns the proposals it reset, so startup can say so out loud instead of silently
   * repairing state.
   */
  reapInterruptedActPhases(): ProposalRow[] {
    const stranded = this.db
      .prepare(`SELECT * FROM proposals WHERE act_status = 'running'`)
      .all() as unknown as ProposalRow[];
    if (stranded.length > 0) {
      this.db.exec(`UPDATE proposals SET act_status = 'interrupted' WHERE act_status = 'running'`);
    }
    return stranded;
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

  // ---- goals ---------------------------------------------------------------
  //
  // Curating goals is the operator's job, exactly like approving proposals: the only
  // model-callable entry point is goal_suggest (see buildMemoryTools), which can create a row
  // with status='suggested' and nothing else. Accepting, editing, pausing, retiring and
  // deleting are all plain methods here that the server calls on a human's click. The agent
  // cannot widen what it works on, only point at where it might be worth widening.

  listGoals(status?: GoalStatus) {
    return (
      status
        ? this.db.prepare(`SELECT * FROM goals WHERE status = ? ORDER BY weight DESC, id ASC`).all(status)
        : this.db.prepare(`SELECT * FROM goals ORDER BY status ASC, weight DESC, id ASC`).all()
    ) as unknown as GoalRow[];
  }

  /** The goals a research cycle actually works on. 'suggested' is deliberately not among them. */
  activeGoals() {
    return this.listGoals("active");
  }

  getGoal(id: number) {
    return this.db.prepare(`SELECT * FROM goals WHERE id = ?`).get(id) as GoalRow | undefined;
  }

  createGoal(g: {
    title: string;
    brief?: string;
    status?: GoalStatus;
    weight?: number;
    origin?: GoalOrigin;
    parentId?: number | null;
    rationale?: string | null;
  }): number {
    const t = now();
    const result = this.db
      .prepare(
        `INSERT INTO goals (title, brief, status, weight, origin, parent_id, rationale, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        g.title,
        g.brief ?? "",
        g.status ?? "active",
        g.weight ?? 1,
        g.origin ?? "human",
        g.parentId ?? null,
        g.rationale ?? null,
        t,
        t
      );
    return Number(result.lastInsertRowid);
  }

  updateGoal(
    id: number,
    fields: { title?: string; brief?: string; status?: GoalStatus; weight?: number; parentId?: number | null }
  ): boolean {
    const existing = this.getGoal(id);
    if (!existing) return false;
    this.db
      .prepare(`UPDATE goals SET title = ?, brief = ?, status = ?, weight = ?, parent_id = ?, updated_at = ? WHERE id = ?`)
      .run(
        fields.title ?? existing.title,
        fields.brief ?? existing.brief,
        fields.status ?? existing.status,
        fields.weight ?? existing.weight,
        fields.parentId === undefined ? existing.parent_id : fields.parentId,
        now(),
        id
      );
    return true;
  }

  /**
   * Deleting a goal must not delete the work done under it. `goal_id` is set to NULL on every
   * row that referenced it -- those proposals/lessons/notes keep their `domain` text snapshot,
   * so they fall back to exactly the state history rows are already in rather than vanishing
   * from the scoreboard.
   */
  deleteGoal(id: number): boolean {
    if (!this.getGoal(id)) return false;
    for (const table of ["proposals", "lessons", "research_notes", "runs"]) {
      this.db.prepare(`UPDATE ${table} SET goal_id = NULL WHERE goal_id = ?`).run(id);
    }
    this.db.prepare(`UPDATE goals SET parent_id = NULL WHERE parent_id = ?`).run(id);
    this.db.prepare(`DELETE FROM goals WHERE id = ?`).run(id);
    return true;
  }

  /**
   * First-run migration off the free-text domain list. Only fires when `goals` is empty, so it
   * can be called unconditionally at startup.
   *
   * The split matters: one of the live domains was a 400-character paragraph of research
   * instructions being used as a grouping key. `title` takes the part before the first comma or
   * dash (capped at a readable length) and `brief` keeps the whole original, so no wording is
   * lost and the key becomes something a human can actually read off a scoreboard.
   */
  seedGoalsFromDomains(domains: readonly string[]): number {
    const existing = this.db.prepare(`SELECT COUNT(*) AS n FROM goals`).get() as { n: number };
    if (existing.n > 0) return 0;

    let created = 0;
    for (const domain of domains) {
      const trimmed = domain.trim();
      if (!trimmed) continue;
      this.createGoal({ title: goalTitleFromDomain(trimmed), brief: trimmed, origin: "human" });
      created++;
    }
    return created;
  }

  /**
   * The closest existing goal to a candidate, if it's close enough to be the same lane
   * reworded. Reuses the proposal duplicate check verbatim -- a goal's title+brief is the same
   * shape of problem as a proposal's domain+description, and the tokenizer already splits
   * CamelCase and stems, which is what catches a rename rather than a genuinely new direction.
   *
   * Checked against goals of *every* status, including retired ones: re-suggesting a lane the
   * operator has already dismissed is precisely the loop this is here to stop.
   */
  findNearDuplicateGoal(candidate: { title: string; brief: string }) {
    const existing = this.listGoals().map((g) => ({ id: g.id, domain: g.title, description: g.brief, goal: g }));
    const match = findNearDuplicate({ domain: candidate.title, description: candidate.brief }, existing);
    return match ? { goal: match.proposal.goal, score: match.score, shared: match.shared } : null;
  }

  /**
   * Which goal a free-text label is talking about, or null.
   *
   * This is what makes the model's wording stop mattering. It still passes a `domain` string to
   * proposal_create/lesson_add/research_note_add and that string is still stored verbatim as the
   * snapshot -- but the row is *filed* under the goal this resolves it to, so a reworded domain
   * lands on the right lane instead of minting a fourteenth key. Resolution happens here rather
   * than as a tool parameter because the model has no reliable way to know a goal's id, and
   * asking it to track one is how drift got in.
   *
   * Deliberately strict, and matched against the **title only**. Two findings from running this
   * over the 13 real historical domain strings:
   *
   *   - Including the brief makes a long goal a magnet. The Swedish goal's 400-character brief
   *     mentions micro-SaaS and tools, so "micro-SaaS tool for developers" scored 0.75 against
   *     it and 0.50 against the micro-SaaS goal it actually belongs near -- confidently wrong.
   *   - A containment measure (overlap coefficient) has the same bias: the more a goal says, the
   *     more of any short label it can absorb.
   *
   * So: symmetric Jaccard against the title, which requires the label to be *about the same
   * thing* rather than merely mentioned by it. Strings with no good answer -- and most of the
   * historical ones genuinely have none -- resolve to null and stay unassigned, which is where
   * every pre-goals row already sits and is still findable by text. The research prompt tells
   * the model to use a goal's exact title as the domain, so the common path is the exact match
   * below and this fuzzy tier is only a safety net for light rewording.
   */
  resolveGoalId(text: string | null | undefined): number | null {
    if (!text?.trim()) return null;
    const label = terms(text);
    if (label.size === 0) return null;

    let best: { id: number; score: number } | null = null;
    for (const goal of this.listGoals()) {
      // A suggested goal is inert, and a retired one was closed on purpose -- filing new work
      // under either would quietly resurrect a lane the operator hasn't opened.
      if (goal.status === "suggested" || goal.status === "retired") continue;
      if (goal.title.trim().toLowerCase() === text.trim().toLowerCase()) return goal.id;

      const { score } = similarity(goal.title, text);
      if (score >= GOAL_MATCH_THRESHOLD && (best === null || score > best.score)) {
        best = { id: goal.id, score };
      }
    }
    return best?.id ?? null;
  }

  /**
   * Per-goal health: enough to answer "is this lane still worth researching?", which was
   * previously invisible -- a goal that had gone quiet looked exactly like a goal nobody had
   * gotten to yet.
   *
   * `empty_cycles` counts research runs since this goal last produced a proposal -- all of them,
   * not just ones charged to this goal, because one research run covers every active goal. (When
   * `runs.goal_id` starts being set, per-goal fan-out would make that filter meaningful; it isn't
   * yet, and filtering on it now would make this permanently zero.)
   *
   * Floored at the goal's own creation time, so a goal can't be blamed for cycles that ran before
   * it existed. Without that, seeding goals against an established database reports every lane as
   * having failed 25 times on its first day and trips the exploration mandate for all of them at
   * once -- a judgement about history the goal had no part in.
   */
  goalHealth() {
    return this.db
      .prepare(
        `SELECT g.id AS goal_id, g.title, g.status, g.weight,
                COUNT(DISTINCT p.id) AS proposals,
                COUNT(DISTINCT CASE WHEN p.status = 'approved' THEN p.id END) AS approved,
                COUNT(DISTINCT CASE WHEN EXISTS (
                  SELECT 1 FROM actions a WHERE a.proposal_id = p.id AND a.phase = 'act'
                ) THEN p.id END) AS shipped,
                COUNT(DISTINCT o.id) AS outcomes,
                COALESCE(SUM(CASE WHEN o.success = 1 THEN 1 ELSE 0 END), 0) AS successes,
                (SELECT COALESCE(SUM(r.cost_usd), 0) FROM runs r
                  WHERE r.goal_id = g.id
                     OR r.proposal_id IN (SELECT p2.id FROM proposals p2 WHERE p2.goal_id = g.id)) AS api_spend,
                (SELECT MAX(p3.created_at) FROM proposals p3 WHERE p3.goal_id = g.id) AS last_proposal_at,
                (SELECT COUNT(*) FROM runs r2
                  WHERE r2.phase = 'research_plan'
                    AND r2.started_at > MAX(
                      g.created_at,
                      COALESCE((SELECT MAX(p4.created_at) FROM proposals p4 WHERE p4.goal_id = g.id), ''))) AS empty_cycles
         FROM goals g
         LEFT JOIN proposals p ON p.goal_id = g.id
         LEFT JOIN outcomes o ON o.proposal_id = p.id
         GROUP BY g.id
         ORDER BY g.weight DESC, g.id ASC`
      )
      .all() as unknown as GoalHealthRow[];
  }

  // ---- research ---------------------------------------------------------

  async addResearchNote(
    topic: string,
    finding: string,
    source?: string,
    confidence?: number,
    opts: { goalId?: number | null; kind?: string | null } = {}
  ) {
    const stmt = this.db.prepare(
      `INSERT INTO research_notes (topic, finding, source, confidence, fetched_at, goal_id, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      topic,
      finding,
      source ?? null,
      confidence ?? null,
      now(),
      opts.goalId ?? null,
      opts.kind ?? null
    );
    const id = Number(result.lastInsertRowid);
    await upsertText("research_notes", id, noteEmbeddingText(topic, finding), {
      goal_id: opts.goalId ?? null,
      kind: opts.kind ?? null,
      confidence: confidence ?? null,
      created_at: now(),
    });
    return id;
  }

  /** Semantic search via Qdrant when configured, falling back to LIKE otherwise. */
  async searchResearchNotes(topic: string, limit = 10, opts: { goalId?: number | null; kind?: string } = {}) {
    const semantic = await this.semanticSearch<ResearchNoteRow>("research_notes", topic, limit, {
      filter: andFilters(goalFilter(opts.goalId), opts.kind ? kindFilter(opts.kind) : undefined),
    });
    if (semantic) return semantic;

    // The fallback can honour the same filters, so a filtered search doesn't silently widen
    // into an unfiltered one just because Qdrant is unavailable.
    const clauses = ["(topic LIKE ? OR finding LIKE ?)"];
    const params: (string | number)[] = [`%${topic}%`, `%${topic}%`];
    if (opts.goalId != null) {
      clauses.push("goal_id = ?");
      params.push(opts.goalId);
    }
    if (opts.kind) {
      clauses.push("kind = ?");
      params.push(opts.kind);
    }
    return this.db
      .prepare(`SELECT * FROM research_notes WHERE ${clauses.join(" AND ")} ORDER BY fetched_at DESC LIMIT ?`)
      .all(...params, limit) as unknown as ResearchNoteRow[];
  }

  /**
   * Notes recording a dead end for one goal -- the negative half of the exploration query, and
   * the digest that stops research re-checking what it already ruled out. Plain SQL: this is an
   * exact attribute lookup, not a similarity question.
   */
  listSaturatedNotes(goalId: number | null, limit = 40) {
    // The LIKE clause is a bridge for rows written before `kind` existed, and only applies to
    // them (`kind IS NULL`). Without it this returns nothing at all until enough new notes
    // accumulate -- and the existing store is roughly a third saturation findings, which is
    // precisely the knowledge the exploration query and the digest need to be useful on day one.
    // These notes say so in their own topic ("... -- saturated Aug 2026", "saturation check"),
    // so this reads a label the model already wrote rather than inferring one. It costs nothing
    // once kinds are being written, and never overrides an explicit kind.
    const base = `SELECT * FROM research_notes
                   WHERE (kind = 'saturated' OR (kind IS NULL AND topic LIKE '%saturat%'))`;
    return (
      goalId == null
        ? this.db.prepare(`${base} ORDER BY fetched_at DESC LIMIT ?`).all(limit)
        : this.db.prepare(`${base} AND goal_id = ? ORDER BY fetched_at DESC LIMIT ?`).all(goalId, limit)
    ) as unknown as ResearchNoteRow[];
  }

  /**
   * "What's worth looking at here that isn't one of the dead ends?"
   *
   * Asks Qdrant for notes close to the goal's own text but far from the notes already marked
   * saturated for it. Returns [] rather than null when there's nothing to go on (no Qdrant, no
   * saturation history yet) -- the caller treats it as "no steer available", not as an error.
   */
  async findUnexploredDirections(goal: GoalRow, limit = 8): Promise<Scored<ResearchNoteRow>[]> {
    const goalText = `${goal.title}\n${goal.brief}`;
    const saturated = this.listSaturatedNotes(goal.id).length > 0
      ? this.listSaturatedNotes(goal.id)
      : this.listSaturatedNotes(null);
    if (saturated.length === 0) return [];

    // Negatives have to be the dead ends *near this goal*, not every dead end on record.
    // Handing `recommend` all of them makes the negative term dominate the score: with the
    // corpus blanketed, every goal came back with the same four notes at negative scores --
    // ranked purely by distance from any dead end, with the goal itself making no difference.
    // Narrowing to the closest few restores the thing being asked for: on topic for this lane,
    // and unlike what this lane has already ruled out.
    const relevant = await this.semanticSearch<ResearchNoteRow>("research_notes", goalText, EXPLORE_NEGATIVES, {
      filter: andFilters(kindFilter("saturated"), goalFilter(goal.id)),
    });
    const negatives = (relevant && relevant.length > 0 ? relevant : saturated.slice(0, EXPLORE_NEGATIVES)).map((n) => n.id);
    if (negatives.length === 0) return [];

    // The dead ends themselves are excluded from the result -- returning one as a "direction"
    // would be recommending exactly what it says not to do.
    const raw = await recommendByText("research_notes", goalText, negatives, limit, {
      filter: { must_not: [{ key: "kind", match: { value: "saturated" } }] },
    });
    if (!raw || raw.length === 0) return [];

    // `best_score` is "similarity to the goal minus similarity to the nearest dead end", so a
    // negative score means the note is closer to something already ruled out than to the goal --
    // by definition not a direction worth suggesting. Dropping those is what makes an empty
    // result honest: for a lane the corpus knows nothing positive about, the right answer is "no
    // steer available", not the four least-bad notes on file. Measured without this, two of four
    // goals returned an identical list of operational notes at negative scores.
    const hits = raw.filter((h) => h.score > 0);
    if (hits.length === 0) return [];

    const placeholders = hits.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM research_notes WHERE id IN (${placeholders})`)
      .all(...hits.map((h) => h.id)) as unknown as ResearchNoteRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return hits
      .map((h) => {
        const row = byId.get(h.id);
        return row ? { ...row, score: h.score } : undefined;
      })
      .filter((r): r is Scored<ResearchNoteRow> => r !== undefined);
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

    await upsertText("research_notes", keepId, noteEmbeddingText(keeper.topic, finding), {
      goal_id: keeper.goal_id,
      kind: keeper.kind,
      confidence,
      created_at: keeper.fetched_at,
    });
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
   * Brings Qdrant in step with SQLite, which is the source of truth for every point.
   *
   * Two jobs: backfilling rows written while Qdrant was unconfigured, and rebuilding after a
   * COLLECTION_VERSION bump (the v2 shape has payloads and a sparse vector that v1 points don't).
   * A version change forces a full pass; otherwise only rows newer than the last sync are sent,
   * because the old behaviour re-upserted every row at every startup, one `?wait=true` request
   * each. That is invisible at 50 rows and won't stay invisible.
   *
   * Payloads are written here too, not just on insert -- they're what every filtered search
   * depends on, so a row that predates them has to get them from somewhere.
   */
  async syncToQdrant() {
    if (!qdrantAvailable) return;

    const marker = this.db.prepare(`SELECT value FROM control_settings WHERE key = 'qdrantSync'`).get() as
      | { value: string }
      | undefined;
    let since: string | null = null;
    if (marker) {
      try {
        const parsed = JSON.parse(marker.value) as { version?: number; at?: string };
        if (parsed.version === QDRANT_SYNC_VERSION) since = parsed.at ?? null;
      } catch {
        // Unreadable marker means a full pass, which is always correct -- just slower.
      }
    }
    const startedAt = now();

    const notes = (
      since
        ? this.db.prepare(`SELECT * FROM research_notes WHERE fetched_at > ? ORDER BY id`).all(since)
        : this.db.prepare(`SELECT * FROM research_notes ORDER BY id`).all()
    ) as unknown as ResearchNoteRow[];
    const lessons = (
      since
        ? this.db.prepare(`SELECT * FROM lessons WHERE updated_at > ? ORDER BY id`).all(since)
        : this.db.prepare(`SELECT * FROM lessons ORDER BY id`).all()
    ) as unknown as LessonRow[];

    if (notes.length > 0) {
      await upsertInBatches(
        "research_notes",
        notes.map((n) => ({
          id: n.id,
          text: noteEmbeddingText(n.topic, n.finding),
          payload: { goal_id: n.goal_id, kind: n.kind, confidence: n.confidence, created_at: n.fetched_at },
        }))
      );
    }
    if (lessons.length > 0) {
      await upsertInBatches(
        "lessons",
        lessons.map((l) => ({
          id: l.id,
          text: lessonEmbeddingText(l.domain, l.lesson),
          payload: { goal_id: l.goal_id, confidence: l.confidence, muted: l.muted, created_at: l.created_at },
        }))
      );
    }
    if (notes.length > 0 || lessons.length > 0) {
      console.log(`[qdrant] synced ${notes.length} note(s) and ${lessons.length} lesson(s)${since ? "" : " (full rebuild)"}`);
    }

    // Written through its own statement rather than saveControlSettings: this is bookkeeping
    // about a sync, not an operator setting, and it has no business appearing in the shape the
    // console-only writer and the control loader both speak.
    this.db
      .prepare(
        `INSERT INTO control_settings (key, value, updated_at) VALUES ('qdrantSync', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify({ version: QDRANT_SYNC_VERSION, at: startedAt }), startedAt);
  }

  /**
   * Ranks `table`'s rows by Qdrant hybrid similarity to `query`, hydrating each hit from SQLite
   * and carrying its relevance score through.
   *
   * Returns null only when the search did not happen (Qdrant unconfigured, or the request
   * failed) -- that's the fallback signal. An empty array is a real answer: the search ran and
   * matched nothing. Conflating the two is what made a genuinely empty result silently re-run as
   * a LIKE substring match and come back with unrelated rows.
   *
   * The score is returned rather than used and discarded: it's what lets lessons be re-ranked by
   * confidence below, and what lets a caller tell a 0.9 match from a 0.3 one instead of trusting
   * position alone.
   */
  private async semanticSearch<T extends { id: number }>(
    table: CollectionName,
    query: string,
    limit: number,
    opts: SearchOptions = {}
  ): Promise<Scored<T>[] | null> {
    const hits = await searchByText(table, query, limit, opts);
    if (!hits) return null;
    if (hits.length === 0) return [];

    const placeholders = hits.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders})`).all(...hits.map((h) => h.id)) as T[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    // A hit whose row is gone (deleted without its point being cleaned up) is dropped rather
    // than erroring -- it shrinks the result set instead of failing the search.
    return hits
      .map((h) => {
        const row = byId.get(h.id);
        return row ? { ...row, score: h.score } : undefined;
      })
      .filter((row): row is Scored<T> => row !== undefined);
  }

  /**
   * "Have we already written this down?" -- the shared machinery behind note and lesson dedup.
   *
   * Dense-only on purpose (see SearchOptions.denseOnly): this is a question about how *similar*
   * two texts are, and fused RRF scores answer a different question. Falls back to the lexical
   * measure when Qdrant is unavailable, so the guard still works offline -- with a threshold on
   * its own scale, since the two aren't comparable.
   */
  private async findDuplicateByText<T extends { id: number }>(
    collection: CollectionName,
    text: string,
    threshold: number,
    lexicalCandidates: () => { row: T; text: string }[]
  ): Promise<{ row: T; score: number } | null> {
    const hits = await searchByText(collection, text, 1, { denseOnly: true, scoreThreshold: threshold });
    if (hits) {
      const top = hits[0];
      if (!top) return null;
      const row = this.db.prepare(`SELECT * FROM ${collection} WHERE id = ?`).get(top.id) as T | undefined;
      return row ? { row, score: top.score } : null;
    }

    let best: { row: T; score: number } | null = null;
    for (const candidate of lexicalCandidates()) {
      const { score } = similarity(text, candidate.text);
      if (score >= LEXICAL_DUPLICATE_THRESHOLD && (best === null || score > best.score)) {
        best = { row: candidate.row, score };
      }
    }
    return best;
  }

  /** The existing note this one would duplicate, if any. See the threshold note for the measurements. */
  async findDuplicateNote(topic: string, finding: string) {
    return this.findDuplicateByText<ResearchNoteRow>(
      "research_notes",
      noteEmbeddingText(topic, finding),
      NOTE_DUPLICATE_THRESHOLD,
      () => this.listAllResearchNotes(500).map((row) => ({ row, text: noteEmbeddingText(row.topic, row.finding) }))
    );
  }

  /** The existing lesson this one would duplicate, if any -- the model should reinforce that one instead. */
  async findDuplicateLesson(domain: string, lesson: string) {
    return this.findDuplicateByText<LessonRow>(
      "lessons",
      lessonEmbeddingText(domain, lesson),
      LESSON_DUPLICATE_THRESHOLD,
      () => this.listAllLessons(500).map((row) => ({ row, text: lessonEmbeddingText(row.domain, row.lesson) }))
    );
  }

  // ---- proposals ----------------------------------------------------------

  createProposal(p: {
    domain: string;
    description: string;
    expectedCost: number;
    expectedTimeHours: number;
    expectedUpside: number;
    requiredTools: string[];
    goalId?: number | null;
    revenueModel?: RevenueModel | null;
    monetization?: Monetization | null;
    steps?: ProposalStep[] | null;
  }) {
    const stmt = this.db.prepare(
      `INSERT INTO proposals (domain, description, expected_cost, expected_time_hours, expected_upside, required_tools, created_at, goal_id, revenue_model, monetization_json, steps_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      p.domain,
      p.description,
      p.expectedCost,
      p.expectedTimeHours,
      p.expectedUpside,
      p.requiredTools.join(","),
      now(),
      p.goalId ?? null,
      p.revenueModel ?? null,
      p.monetization ? JSON.stringify(p.monetization) : null,
      p.steps ? JSON.stringify(p.steps) : null
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

  /** Pending or approved -- the proposals a new one would be a duplicate *of*. */
  listOpenProposals() {
    return this.db
      .prepare(`SELECT * FROM proposals WHERE status IN ('pending', 'approved') ORDER BY created_at DESC`)
      .all() as unknown as ProposalRow[];
  }

  /**
   * The open proposals a new one is actually checked against.
   *
   * Two carve-outs, and they are the same carve-out twice.
   *
   * **Rejected** proposals were never in `listOpenProposals` to begin with: a rejection comes
   * with a reason, and the improved retry that reason asks for is a *good* proposal that scores
   * as a near-duplicate of the thing it improves on. Blocking it turns one "no" into a permanent
   * ban on the subject.
   *
   * **Approved proposals whose act phase didn't finish** are excluded here for exactly that
   * reason. A proposal to complete unbuilt work is, by construction, near-identical to the work
   * -- there is no wording that both describes finishing #27 and doesn't resemble #27. The
   * refinement pass on #27 hit this for real: `proposal_create` was refused twice (43% then 32%
   * overlap) and only landed on the third attempt, after the model had reworded it enough to
   * slip under the threshold. It got through by sounding different, not by being different,
   * which is the exact selection pressure this check exists to avoid creating.
   *
   * `interrupted` is included in the carve-out and `running` is deliberately not: research runs
   * concurrently with act, so a proposal being built *right now* is precisely one a new proposal
   * must not duplicate. See `reapInterruptedActPhases` for what separates the two.
   */
  listDuplicateCandidates() {
    return this.db
      .prepare(
        `SELECT * FROM proposals
          WHERE status IN ('pending', 'approved')
            AND (act_status IS NULL OR act_status IN ('running', 'complete'))
          ORDER BY created_at DESC`
      )
      .all() as unknown as ProposalRow[];
  }

  /** The closest open proposal to a candidate, if it's close enough to be the same idea reworded. */
  findDuplicateProposal(candidate: { domain: string; description: string }) {
    return findNearDuplicate(candidate, this.listDuplicateCandidates());
  }

  /**
   * Marks an act phase as in flight. Written before the model is called, so a crash between
   * here and the verdict leaves a `running` row for the next startup to reap rather than a
   * proposal that looks like it never acted.
   */
  markActStarted(id: number) {
    this.db.prepare(`UPDATE proposals SET act_status = 'running', act_problems = NULL WHERE id = ?`).run(id);
  }

  /** Records what `verifyAct` concluded once the act phase returned. */
  recordActVerdict(id: number, verdict: { complete: boolean; problems: string[] }) {
    this.db
      .prepare(`UPDATE proposals SET act_status = ?, act_problems = ? WHERE id = ?`)
      .run(verdict.complete ? "complete" : "incomplete", verdict.problems.length ? JSON.stringify(verdict.problems) : null, id);
  }

  /** Approved proposals whose act phase started and never reached a verdict, or reached a bad one. */
  listUnfinishedActs(): ProposalRow[] {
    return this.db
      .prepare(
        `SELECT * FROM proposals
          WHERE status = 'approved' AND act_status IN ('interrupted', 'incomplete')
          ORDER BY decided_at DESC`
      )
      .all() as unknown as ProposalRow[];
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
  listActionHistory(filter: { goalId?: number; text?: string } = {}, limit = 20) {
    const base = `SELECT a.tool_name, a.tool_input, a.tool_output, a.occurred_at, a.proposal_id,
                          p.domain, p.description AS proposal_description
                   FROM actions a JOIN proposals p ON p.id = a.proposal_id
                   WHERE p.status = 'approved' AND a.phase = 'act'`;

    // Matching is goal_id OR text, never goal_id alone. Every proposal predating goals has
    // goal_id = NULL under one of 13 free-text domain spellings, so an id-only filter would
    // report "nothing has been built here" for work that plainly has been -- which is exactly
    // how the old exact `p.domain = ?` filter failed, and the guard the research prompt leans
    // on to avoid re-building shipped work.
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.goalId !== undefined) {
      clauses.push("p.goal_id = ?");
      params.push(filter.goalId);
    }
    if (filter.text?.trim()) {
      const like = `%${filter.text.trim()}%`;
      clauses.push("p.domain LIKE ?", "p.description LIKE ?");
      params.push(like, like);
    }

    const where = clauses.length > 0 ? ` AND (${clauses.join(" OR ")})` : "";
    const rows = this.db
      .prepare(`${base}${where} ORDER BY a.occurred_at DESC LIMIT ?`)
      .all(...params, limit) as unknown as ActionHistoryRow[];

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
  async searchLessons(domain: string, limit = 10, opts: { goalId?: number | null } = {}) {
    // Muting is enforced in Qdrant's own filter now, not in JS afterwards. The old post-filter
    // over-fetched `limit * 2` to compensate and still shrank the result set when enough top
    // hits were muted; a server-side must_not returns `limit` unmuted rows, full stop. This is
    // still the single chokepoint every lesson_search goes through, so muting one lesson takes
    // it out of the agent's reasoning everywhere at once.
    const semantic = await this.semanticSearch<LessonRow>("lessons", domain, limit, {
      filter: andFilters(notMutedFilter(), goalFilter(opts.goalId)),
    });
    if (semantic) return this.rankLessons(semantic, limit);

    return this.db
      .prepare(
        `SELECT * FROM lessons WHERE domain = ? AND muted = 0 ORDER BY confidence DESC, updated_at DESC LIMIT ?`
      )
      .all(domain, limit) as unknown as LessonRow[];
  }

  /**
   * Blends relevance with track record.
   *
   * The LIKE fallback has always ordered by `confidence DESC, updated_at DESC`, but the moment
   * Qdrant was configured that ordering stopped applying at all -- results came back in pure
   * similarity order, so a 0.1-confidence lesson the agent had already been contradicted on
   * could outrank one reinforced to 0.9. Reinforcement was being recorded and then ignored,
   * which is worse than not recording it.
   *
   * Relevance still dominates (confidence scales it by 0.5x-1.0x rather than replacing it): a
   * highly-confident lesson about something else is still the wrong answer.
   */
  private rankLessons(rows: Scored<LessonRow>[], limit: number) {
    return [...rows]
      .sort((a, b) => b.score * (0.5 + 0.5 * b.confidence) - a.score * (0.5 + 0.5 * a.confidence))
      .slice(0, limit);
  }

  /**
   * Free-text lesson search for the console's operator, as distinct from searchLessons above:
   * that one's LIKE fallback matches `domain` exactly, which is right for the agent (it looks
   * lessons up by the domain it's working in) but useless for a human typing a phrase from the
   * lesson body. Same semantic path, same muted filter -- only the fallback differs.
   */
  async searchLessonsByText(query: string, limit = 10) {
    const semantic = await this.semanticSearch<LessonRow>("lessons", query, limit, { filter: notMutedFilter() });
    if (semantic) return this.rankLessons(semantic, limit);

    const like = `%${query}%`;
    return this.db
      .prepare(
        `SELECT * FROM lessons WHERE muted = 0 AND (domain LIKE ? OR lesson LIKE ?)
         ORDER BY confidence DESC, updated_at DESC LIMIT ?`
      )
      .all(like, like, limit) as unknown as LessonRow[];
  }

  async addLesson(
    domain: string,
    lessonText: string,
    derivedFromOutcomeId?: number,
    opts: { goalId?: number | null } = {}
  ) {
    const stmt = this.db.prepare(
      `INSERT INTO lessons (domain, lesson, derived_from_outcome_id, created_at, updated_at, goal_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const t = now();
    const result = stmt.run(domain, lessonText, derivedFromOutcomeId ?? null, t, t, opts.goalId ?? null);
    const id = Number(result.lastInsertRowid);
    await upsertText("lessons", id, lessonEmbeddingText(domain, lessonText), {
      goal_id: opts.goalId ?? null,
      confidence: 0.5,
      muted: 0,
      created_at: t,
    });
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
    // An operator retitling a lesson's domain is also the moment to re-file it, since the
    // rewording is usually the point of the edit.
    const goalId = fields.domain !== undefined ? this.resolveGoalId(domain) : existing.goal_id;
    this.db
      .prepare(`UPDATE lessons SET domain = ?, lesson = ?, goal_id = ?, updated_at = ?, edited_at = ? WHERE id = ?`)
      .run(domain, lessonText, goalId, now(), now(), id);
    // Keep the vector and payload in step with the row, or semantic search would keep matching
    // the old wording and filtering on the old goal.
    await upsertText("lessons", id, lessonEmbeddingText(domain, lessonText), {
      goal_id: goalId,
      confidence: existing.confidence,
      muted: existing.muted,
      created_at: existing.created_at,
    });
    return true;
  }

  /**
   * Excludes a lesson from lesson_search without deleting it -- the row stays as a record of
   * what was believed and when, but it stops steering future cycles.
   */
  async setLessonMuted(id: number, muted: boolean) {
    this.db.prepare(`UPDATE lessons SET muted = ?, updated_at = ? WHERE id = ?`).run(muted ? 1 : 0, now(), id);
    // The mute filter runs inside Qdrant now, so the flag has to exist on the point as well --
    // a mute written only to SQLite would leave the lesson being handed to the model forever,
    // which is the exact failure muting exists to prevent.
    await setPayload("lessons", id, { muted: muted ? 1 : 0 });
  }

  async deleteLesson(id: number) {
    this.db.prepare(`DELETE FROM lessons WHERE id = ?`).run(id);
    await deletePoint("lessons", id);
  }

  async reinforceLesson(id: number, direction: "confirmed" | "contradicted") {
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
    // Ranking reads confidence off the hydrated SQLite row, so this isn't load-bearing today --
    // it keeps the payload from going stale against the column it mirrors, which is what would
    // make a later filter on confidence quietly wrong.
    const updated = this.getLesson(id);
    if (updated) await setPayload("lessons", id, { confidence: updated.confidence });
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
    model?: string,
    // Set when a run is attributable to one goal -- research/plan runs carry no proposal_id, so
    // without this their spend can only ever land in the unattributed bucket on the Economics
    // page, and per-goal health has nothing to count cycles with.
    goalId?: number | null
  ) {
    this.db
      .prepare(
        `INSERT INTO runs (proposal_id, phase, cost_usd, duration_ms, started_at, provider, model, goal_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(proposalId, phase, costUsd, durationMs ?? null, startedAt, provider ?? null, model ?? null, goalId ?? null);
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

  /**
   * Operator settings (settings.ts), stored in the same table under a `setting:` prefix.
   *
   * A prefix rather than a second table because these are the same kind of thing as the
   * control keys -- an operator preference that outlives the process -- and because
   * `loadControlSettings` above already ignores keys it doesn't recognise, so the two
   * namespaces can't collide. Validation lives in settings.ts, not here: this returns the
   * raw parsed values and lets the registry decide what is acceptable, so a setting whose
   * range changes doesn't need a migration.
   */
  loadSettings(): Record<string, unknown> {
    const rows = this.db
      .prepare(`SELECT key, value FROM control_settings WHERE key LIKE 'setting:%'`)
      .all() as unknown as { key: string; value: string }[];
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        out[row.key.slice("setting:".length)] = JSON.parse(row.value);
      } catch {
        // Same stance as loadControlSettings: a hand-edited row falls back to the env
        // value for that key rather than stopping the loop from starting.
        console.warn(`[settings] ignoring unparseable setting "${row.key}"`);
      }
    }
    return out;
  }

  saveSettings(patch: Record<string, unknown>): void {
    const stmt = this.db.prepare(
      `INSERT INTO control_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    const at = now();
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      stmt.run(`setting:${key}`, JSON.stringify(value), at);
    }
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
   *
   * Grouped by the goal's title where a proposal has one, and by its stored `domain` text where
   * it doesn't. That keeps the pre-goals rows visible under the (many) spellings they were
   * actually written with -- honest about the fragmentation rather than hiding it -- while
   * everything written since consolidates onto one row per goal no matter what the model called
   * it that cycle. Both halves of the api_spend subquery match the same way, or spend would
   * stop following the work it paid for.
   */
  domainScoreboard() {
    return this.db
      .prepare(
        `SELECT COALESCE(g.title, p.domain) AS domain,
                COUNT(DISTINCT p.id) AS proposals,
                COUNT(DISTINCT CASE WHEN p.status = 'approved' THEN p.id END) AS approved,
                COUNT(DISTINCT o.id) AS outcomes,
                COALESCE(SUM(CASE WHEN o.success = 1 THEN 1 ELSE 0 END), 0) AS successes,
                COALESCE(SUM(o.actual_revenue), 0) AS revenue,
                COALESCE(SUM(o.actual_cost), 0) AS reported_cost,
                COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN p.expected_upside ELSE 0 END), 0) AS forecast_upside,
                (SELECT COALESCE(SUM(r.cost_usd), 0) FROM runs r
                   JOIN proposals rp ON rp.id = r.proposal_id
                   LEFT JOIN goals rg ON rg.id = rp.goal_id
                  WHERE COALESCE(rg.title, rp.domain) = COALESCE(g.title, p.domain)) AS api_spend
         FROM proposals p
         LEFT JOIN goals g ON g.id = p.goal_id
         LEFT JOIN outcomes o ON o.proposal_id = p.id
         GROUP BY COALESCE(g.title, p.domain)
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
  goal_id: number | null;
  /** null on every row written before kinds existed -- see the migration note. */
  kind: string | null;
}

/**
 * A row plus how well it matched. Carried through search results so relevance is available to
 * rank on and to show, rather than being thrown away the moment Qdrant returns it.
 */
export type Scored<T> = T & { score: number };

/** What a research note is telling you. Drives filtering, not just display. */
export const NOTE_KINDS = ["gap", "saturated", "competitor", "pricing", "spec", "inventory", "meta"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export type GoalStatus = "active" | "paused" | "retired" | "suggested";
export type GoalOrigin = "human" | "agent";

export interface GoalRow {
  id: number;
  title: string;
  brief: string;
  status: GoalStatus;
  weight: number;
  origin: GoalOrigin;
  parent_id: number | null;
  rationale: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoalHealthRow {
  goal_id: number;
  title: string;
  status: GoalStatus;
  weight: number;
  proposals: number;
  approved: number;
  shipped: number;
  outcomes: number;
  successes: number;
  api_spend: number;
  last_proposal_at: string | null;
  /** Research runs charged to this goal since its last proposal -- the "is this lane dead?" number. */
  empty_cycles: number;
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
  goal_id: number | null;
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

/** How money actually arrives. Its own column, not folded into the JSON, so it can be grouped on. */
export const REVENUE_MODELS = [
  "affiliate",
  "subscription",
  "one_off",
  "ads",
  "marketplace",
  "service",
  "lead_gen",
  "other",
] as const;
export type RevenueModel = (typeof REVENUE_MODELS)[number];

/** The money path, as the research phase had to state it before the proposal could be filed. */
export interface Monetization {
  whoPays: string;
  pricePoint: string;
  pathToFirstDollar: string;
  daysToFirstDollar: number;
  keyAssumption: string;
  validationSignal: string;
}

/**
 * One step between approval and revenue. `tool` on an agent-owned step is checked against
 * `required_tools` at create time, which is what keeps "the steps needed" and "what the fence
 * permits" from becoming two unrelated pieces of prose.
 */
export interface ProposalStep {
  title: string;
  owner: "agent" | "human";
  tool?: string;
  doneWhen: string;
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
  review_status: "mvp_done" | "needs_refinement" | null;
  priority: Priority;
  scheduled_at: string | null;
  recurrence_ms: number | null;
  next_run_at: string | null;
  /** Set only when a human edited the scope at approval time -- what the model originally asked for. */
  original_required_tools: string | null;
  original_description: string | null;
  /** Null on every proposal written before the monetization block existed; see migrate(). */
  revenue_model: RevenueModel | null;
  /** JSON-encoded {@link Monetization}. */
  monetization_json: string | null;
  /** JSON-encoded {@link ProposalStep}[]. */
  steps_json: string | null;
  /** How the approved work went. NULL on anything that has never reached the act phase. */
  act_status: ActStatus | null;
  /** JSON-encoded string[] of what `verifyAct` objected to. NULL when it had no objections. */
  act_problems: string | null;
}

/**
 * The life of an act phase, as the record sees it.
 *
 * - `running` — started, still going. Only ever true of the live process; see `reapInterruptedActPhases`.
 * - `interrupted` — started and the process went away before it finished. Nobody is coming back for it.
 * - `complete` — ran, did every agent-owned step, recorded an outcome.
 * - `incomplete` — ran and didn't. Truncated, out of turns, steps skipped, or no outcome recorded.
 *
 * `interrupted` and `incomplete` are separate because they need different responses: one is an
 * infrastructure failure that a re-run may simply fix, the other is the model not finishing the
 * job, which is a reason to look at the proposal.
 */
export type ActStatus = "running" | "interrupted" | "complete" | "incomplete";

/** Parses a proposal's stored monetization block, tolerating the nulls on legacy rows. */
export function parseMonetization(row: Pick<ProposalRow, "monetization_json">): Monetization | null {
  if (!row.monetization_json) return null;
  try {
    return JSON.parse(row.monetization_json) as Monetization;
  } catch {
    return null;
  }
}

/** Parses a proposal's stored step list, tolerating the nulls on legacy rows. */
export function parseSteps(row: Pick<ProposalRow, "steps_json">): ProposalStep[] {
  if (!row.steps_json) return [];
  try {
    const parsed = JSON.parse(row.steps_json);
    return Array.isArray(parsed) ? (parsed as ProposalStep[]) : [];
  } catch {
    return [];
  }
}

/**
 * One-line, length-capped rendering of arbitrary text -- used wherever a stored row has to be
 * quoted back into a prompt, a tool result or a log line without dragging its full body along.
 * Lives here rather than in orchestrator.ts because tool results need it too, and the dependency
 * only runs one way (orchestrator imports this module, never the reverse).
 */
export function preview(value: unknown, max = 150): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  const oneLine = (s ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Longest a derived goal title may be -- past this it stops working as a column heading. */
const GOAL_TITLE_MAX = 70;

/**
 * Reduces a legacy domain string to something usable as a key.
 *
 * These strings were written to be read by a model, not grouped by, so they run long and
 * frequently carry their qualifiers after a dash or comma ("micro-SaaS for the Swedish market
 * -- research in Swedish (svenska sokord...)"). Cutting at the first separator keeps the part
 * that names the lane and drops the part that instructs it; the full text is preserved verbatim
 * as the goal's brief, so this only ever shortens the *label*.
 */
export function goalTitleFromDomain(domain: string): string {
  const head = domain.split(/\s+--+\s+|\s+[–—]\s+|,/)[0].trim() || domain.trim();
  if (head.length <= GOAL_TITLE_MAX) return head;
  // Cut on a word boundary rather than mid-word; fall back to a hard slice for text with no spaces.
  const clipped = head.slice(0, GOAL_TITLE_MAX);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > GOAL_TITLE_MAX / 2 ? clipped.slice(0, lastSpace) : clipped).trim();
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
      kind: z
        .enum(NOTE_KINDS)
        .optional()
        .describe(
          "What kind of finding this is. 'saturated' means you checked and the space is already well covered -- " +
            "mark those honestly, they are how you avoid re-checking the same dead ends next cycle. 'gap' means " +
            "you found something underserved."
        ),
      domain: z
        .string()
        .optional()
        .describe("Which of the goals you're researching this belongs to; omit if it spans several or none"),
    },
    async ({ topic, finding, source, confidence, kind, domain }) => {
      const duplicate = await store.findDuplicateNote(topic, finding);
      if (duplicate) {
        const { row, score } = duplicate;
        console.log(`[research_note_add] refused a near-duplicate of note #${row.id} (${score.toFixed(2)})`);
        return [
          `Not saved -- this is nearly identical to research note #${row.id} (${(score * 100).toFixed(0)}% similar), recorded ${row.fetched_at.slice(0, 10)}.`,
          `#${row.id} [${row.topic}]: ${preview(row.finding, 240)}`,
          `Writing the same finding twice makes the store harder to search, not more informative.`,
          `If you have genuinely learned something that note doesn't already say, save that -- the new part, stated as its own finding -- rather than the whole thing again.`,
        ].join("\n");
      }

      const id = await store.addResearchNote(topic, finding, source, confidence, {
        goalId: store.resolveGoalId(domain ?? topic),
        kind: kind ?? null,
      });
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
      // The reflect prompt already says to reinforce rather than duplicate, and the store still
      // ended up with two ~95%-identical credential lessons written 50 seconds apart into two
      // different domains. Advice loses; this doesn't. Refused in-band so the model reads it and
      // gets a turn to do the right thing instead, with the id it needs to do it.
      const duplicate = await store.findDuplicateLesson(domain, lesson);
      if (duplicate) {
        const { row, score } = duplicate;
        console.log(`[lesson_add] refused a near-duplicate of lesson #${row.id} (${score.toFixed(2)})`);
        return [
          `Not saved -- lesson #${row.id} already says this (${(score * 100).toFixed(0)}% similar).`,
          `#${row.id} [${row.domain}] confidence ${row.confidence}, reinforced ${row.times_reinforced}x: ${preview(row.lesson, 240)}`,
          `Call lesson_reinforce with id ${row.id} and direction "confirmed" if this outcome backs it up, or "contradicted" if it cuts against it.`,
          `That is strictly better than a second copy: it raises the confidence of the lesson that already exists, where a duplicate splits the evidence across two rows and buries both.`,
        ].join("\n");
      }

      const id = await store.addLesson(domain, lesson, derivedFromOutcomeId, {
        goalId: store.resolveGoalId(domain),
      });
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
    "Propose a specific, boundable action for a human to approve. Every proposal needs a concrete cost/time/upside estimate, a monetization block saying how it actually earns and what the path to the first dollar is, an ordered step list, and the exact list of tools it needs -- no proposal is executed without human approval, and execution is locked to exactly the tools listed here.",
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
      revenueModel: z.enum(REVENUE_MODELS).describe("How money actually arrives"),
      monetization: z
        .object({
          whoPays: z.string().describe("The specific buyer -- a role, a company type, a named market. Not 'users'."),
          pricePoint: z.string().describe("e.g. '$29/mo', '3% affiliate commission on a ~$400 order', '$0.50 CPM'"),
          pathToFirstDollar: z
            .string()
            .describe(
              "The concrete mechanism that collects the first payment -- a Stripe payment link, a named " +
                "affiliate programme, a specific ad network. Not 'monetize later' and not 'add payments'."
            ),
          daysToFirstDollar: z.number().int().min(0).describe("Realistic days from approval to first payment"),
          keyAssumption: z.string().describe("The one thing that, if it turns out to be false, kills this"),
          validationSignal: z.string().describe("What you would measure to know whether it is working"),
        })
        .describe("How this makes money. A human reviews this to decide; vagueness here is what gets rejected."),
      steps: z
        .array(
          z.object({
            title: z.string(),
            owner: z.enum(["agent", "human"]).describe("'agent' if the act phase does it, 'human' if you cannot"),
            tool: z
              .string()
              .optional()
              .describe("For an agent step, the exact tool name it needs -- it must also be in requiredTools"),
            doneWhen: z.string().describe("The observable condition that means this step is finished"),
          })
        )
        .min(2)
        .max(10)
        .describe("Ordered steps from approval to the first dollar, including the ones only a human can do"),
    },
    async ({
      domain,
      description,
      expectedCost,
      expectedTimeHours,
      expectedUpside,
      requiredTools,
      revenueModel,
      monetization,
      steps,
    }) => {
      // The steps and the fence have to be the same statement, not two pieces of prose that
      // happen to sit on one row. An agent-owned step naming a tool the proposal isn't asking
      // for means one of the two is wrong, and which one it is isn't guessable from here --
      // so it goes back to the model rather than being silently reconciled. Refused in band,
      // like the duplicate check below.
      const missing = steps
        .filter((s) => s.owner === "agent" && s.tool && !requiredTools.includes(s.tool))
        .map((s) => `"${s.title}" needs ${s.tool}`);
      if (missing.length > 0) {
        return [
          `Not created -- ${missing.length} step${missing.length === 1 ? "" : "s"} name a tool that isn't in requiredTools:`,
          ...missing.map((m) => `  - ${m}`),
          `requiredTools is: ${requiredTools.join(", ") || "(empty)"}`,
          `The act phase is fenced to exactly requiredTools, so a step needing anything else cannot run. Either add the tool to requiredTools, or change that step's owner to "human" if a person has to do it.`,
        ].join("\n");
      }

      // Last line of defence against the same idea arriving under a new name. The research
      // prompt already lists the open queue, but advice loses to a good-sounding rewording --
      // this doesn't. Refused in-band (a normal tool result, not an exception) so the model
      // reads it and gets another turn to propose something genuinely different.
      const duplicate = store.findDuplicateProposal({ domain, description });
      if (duplicate) {
        const { proposal, score, shared } = duplicate;
        const state = proposal.status === "pending" ? "still awaiting review" : "already approved";
        console.log(
          `[proposal_create] refused a near-duplicate of #${proposal.id} (${score.toFixed(2)} overlap)`
        );
        return [
          `Not created -- this is too close to proposal #${proposal.id}, which is ${state}.`,
          `Overlap: ${(score * 100).toFixed(0)}% of the distinctive terms in the two are shared (${shared.slice(0, 12).join(", ")}).`,
          `#${proposal.id} [${proposal.domain}]: ${proposal.description.split("\n").find((l) => l.trim()) ?? proposal.description}`,
          `Re-proposing it doesn't get it built any sooner -- it only buries the original in the review queue.`,
          `If there is real work left here, propose the concrete *next step* on #${proposal.id} instead: name that id in your description and scope it to what #${proposal.id} does not already cover. If your idea genuinely differs, say how in the description -- restating the same pitch in different words will be refused again.`,
        ].join("\n");
      }

      const id = store.createProposal({
        domain,
        description,
        expectedCost,
        expectedTimeHours,
        expectedUpside,
        requiredTools,
        goalId: store.resolveGoalId(domain),
        revenueModel,
        monetization,
        steps,
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
      // Both filters, not either: goal_id reaches work filed under this goal, the text match
      // reaches work built before goals existed (and under whatever the model called the domain
      // that cycle). Filtering by id alone would report "nothing built here" for a lane that has
      // shipped, which is the exact failure this tool exists to prevent.
      const n = limit ?? 20;
      const rows = store.listActionHistory({ goalId: store.resolveGoalId(domain) ?? undefined, text: domain }, n);
      if (rows.length > 0 || !domain) return JSON.stringify(rows, null, 2);

      // A filtered miss is not evidence that nothing has been built. The old exact-domain filter
      // answered "[]" for every configured domain while 140 act-phase actions sat in the table,
      // and "[]" reads as "this space is clear" -- the most expensive thing this tool can say
      // wrongly. Widen to recent history across all goals and label it, so the model gets the
      // real picture and knows the filter, not the record, is what came up empty.
      const recent = store.listActionHistory({}, n);
      if (recent.length === 0) return "[]";
      return [
        `No act-phase actions matched "${domain}" specifically. Showing recent history across all goals instead --`,
        `the domain wording may differ from what past cycles used, so check these before assuming nothing exists here.`,
        JSON.stringify(recent, null, 2),
      ].join("\n");
    }
  );

  const goalSuggest = defineTool(
    "goal_suggest",
    "Suggest a new research direction (a 'goal') for the operator to consider -- an adjacent lane that looks live, " +
      "not another idea inside an existing one. A suggestion is inert: it is never researched, and never affects " +
      "what you work on, unless a human accepts it. Use this when a goal you were given keeps coming up empty and " +
      "the interesting signal is next door, rather than forcing a weak proposal inside a lane that's played out.",
    {
      title: z.string().describe("Short, stable name for the lane -- how it would read as a column heading"),
      brief: z
        .string()
        .describe(
          "What researching this lane should mean, concretely: what to look for, what to avoid, which markets or " +
            "audiences, any incumbents to check first. This is the instruction a future cycle reads, so write it " +
            "for someone with no memory of this conversation."
        ),
      rationale: z.string().describe("Why you think this has potential, and what you saw that suggests it"),
      parentGoalTitle: z.string().optional().describe("The existing goal this branches off, if it is a branch"),
    },
    async ({ title, brief, rationale, parentGoalTitle }) => {
      // Same shape of guard as proposal_create, for the same reason: a lane that keeps coming
      // up empty is exactly the situation that produces the same "new" direction over and over.
      // Checked against retired goals too -- re-suggesting something the operator already
      // dismissed is the loop this is here to break, not an edge case.
      const duplicate = store.findNearDuplicateGoal({ title, brief });
      if (duplicate) {
        const { goal, score, shared } = duplicate;
        console.log(`[goal_suggest] refused a near-duplicate of goal #${goal.id} (${score.toFixed(2)} overlap)`);
        return [
          `Not suggested -- this is too close to the existing goal #${goal.id} "${goal.title}" (status: ${goal.status}).`,
          `Overlap: ${(score * 100).toFixed(0)}% of the distinctive terms are shared (${shared.slice(0, 12).join(", ")}).`,
          goal.status === "retired" || goal.status === "paused"
            ? `That lane is ${goal.status} -- the operator has already decided about it, and re-suggesting it doesn't reopen the question.`
            : `That lane already exists, so research it rather than proposing it again.`,
          `If you genuinely mean something narrower or adjacent, say what it excludes that #${goal.id} covers.`,
        ].join("\n");
      }

      const parentId = parentGoalTitle ? store.resolveGoalId(parentGoalTitle) : null;
      const id = store.createGoal({
        title,
        brief,
        rationale,
        parentId,
        status: "suggested",
        origin: "agent",
      });
      emitAgentEvent({ type: "goal_suggested", goalId: id, title, rationale });
      return (
        `Suggested goal #${id} "${title}" -- it is waiting for the operator and is NOT active. ` +
        `Nothing about this cycle changes: keep working within the goals you were actually given.`
      );
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
    goalSuggest,
  ]);
}
