// src/mcp/render.ts
//
// The pure half of the MCP server: rows in, Markdown out, plus the small lookups that
// turn a human's goal *title* into a goal. Nothing here opens or touches the database,
// which is what lets render.test.ts exercise it without a DB file or an API key -- the
// same stance deliverables.ts and act-verification.ts take.
//
// Everything an MCP client sees is prose, so the formatting decisions here are the
// interface. Two rules run through all of them:
//
//   - A field that is null on legacy rows renders *nothing*, never a dash. Most of these
//     columns (monetization, steps, act_status, goal_id) were added to a live database
//     and deliberately not backfilled, so "absent" is the common case, not an anomaly,
//     and a row of dashes reads like a broken record instead of an older one.
//   - Anything that says whether work actually *finished* comes before anything that
//     says what it produced. An unfinished build with a real repo URL must not read as
//     shipped; see the act_status note in deliverables.ts.

import "../mcp-env.js";
import {
  parseMonetization,
  parseSteps,
  preview,
  type GoalHealthRow,
  type GoalRow,
  type ProposalRow,
} from "../memory-server.js";
import { toolRisk } from "../tool-catalog.js";
import type { Deliverable } from "../deliverables.js";

// ---- primitives -----------------------------------------------------------

export const result = (text: string) => ({ content: [{ type: "text" as const, text }] });

export const rendered = (heading: string, blocks: string[], empty: string) =>
  result(blocks.length === 0 ? empty : `${heading} (${blocks.length})\n\n${blocks.join("\n\n---\n\n")}`);

/** The `#12 · 2026-08-01 · goal: x` line every block opens with. Blank parts drop out. */
export const meta = (parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" · ");

/** Semantic hits arrive as Scored<T>; the LIKE fallback's rows have no score at all. */
export const scoreOf = (row: object) => ("score" in row ? (row as { score: number }).score : undefined);

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Tool names keep their `mcp__memory__` / `mcp__integrations__` prefixes in the database
 * because those strings are the fence on already-approved proposals. They're noise to read,
 * so they're stripped for display only -- exactly what the console does.
 */
export const shortTool = (name: string) => name.replace(/^mcp__[a-z_]+__/, "");

/**
 * The fence is stored comma-separated, not as JSON -- `"WebSearch,mcp__integrations__github_create_repo"`.
 * Same split `actPhase` does when it builds the grant, so what this prints is what act is allowed.
 */
function parseToolList(raw: string | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `act_problems`, unlike `required_tools`, really is a JSON string[]. */
function parseProblems(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// ---- goals ----------------------------------------------------------------

/**
 * Goals are named, not numbered, everywhere a human touches them, so every tool that scopes
 * to one takes a title. A miss answers with the titles that do exist, which teaches the client
 * the vocabulary in the same turn it got the name wrong.
 *
 * Takes the goal list rather than reaching for the store, so it stays testable and so this
 * module keeps its promise of touching no database.
 */
export function resolveGoal(goals: GoalRow[], name: string): GoalRow {
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

export function goalTitles(goals: GoalRow[]): Map<number, string> {
  return new Map(goals.map((g) => [g.id, g.title]));
}

export function renderGoal(goal: GoalRow, health?: GoalHealthRow): string {
  const head = meta([
    `#${goal.id}`,
    goal.status,
    `weight ${goal.weight}`,
    `origin: ${goal.origin}`,
    `created ${day(goal.created_at)}`,
  ]);

  const sections = [`## ${goal.title}`, head];

  // The brief is the research instructions the model is handed verbatim, not a label --
  // truncating it would hide the half of a goal that actually steers the loop.
  if (goal.brief.trim()) sections.push("", goal.brief.trim());

  if (goal.status === "suggested") {
    sections.push(
      "",
      goal.rationale ? `Rationale: ${goal.rationale}` : "",
      "Suggested, therefore inert: it is excluded from research and nothing can be filed under it " +
        "until a human accepts it in the console."
    );
  }

  if (health) {
    sections.push(
      "",
      meta([
        `${health.proposals} proposals`,
        `${health.approved} approved`,
        `${health.shipped} shipped`,
        `${health.outcomes} outcomes (${health.successes} successful)`,
        `${money(health.api_spend)} model API spend`,
        health.last_proposal_at ? `last proposal ${day(health.last_proposal_at)}` : "no proposal yet",
        // The "is this lane dead?" number: research cycles that ran and produced nothing here.
        health.empty_cycles > 0 ? `${health.empty_cycles} empty cycles since` : false,
      ])
    );
  }

  return sections.filter((s) => s !== "").join("\n").trimEnd();
}

// ---- proposals ------------------------------------------------------------

export interface OutcomeLike {
  proposal_id: number;
  actual_revenue: number;
  actual_cost: number;
  actual_time_hours: number;
  success: number;
  notes: string | null;
  recorded_at: string;
}

export interface ProposalSpend {
  costUsd: number;
  phases: number;
}

/** The money line, or nothing at all on a proposal filed before the block existed. */
function moneyLine(row: ProposalRow): string | null {
  const m = parseMonetization(row);
  if (!row.revenue_model && !m) return null;
  return meta([
    row.revenue_model ?? false,
    m?.pricePoint,
    m ? `first dollar in ${m.daysToFirstDollar} days` : false,
    m?.whoPays ? `paid by ${m.whoPays}` : false,
  ]);
}

export function renderProposalSummary(row: ProposalRow, goals: Map<number, string>, goalId?: number | null): string {
  const head = meta([
    // No `#id` here -- the heading above already carries it.
    row.status,
    `${row.priority} priority`,
    `created ${day(row.created_at)}`,
    // Only ever set once a proposal has reached the act phase; absent is the normal state.
    row.act_status ? `act: ${row.act_status}` : false,
    row.review_status ?? false,
    goalId != null ? `goal: ${goals.get(goalId) ?? goalId}` : false,
  ]);

  const lines = [`## #${row.id} · ${row.domain}`, head, "", preview(row.description, 400)];

  const mon = moneyLine(row);
  if (mon) lines.push("", `Money: ${mon}`);

  lines.push(
    "",
    meta([
      `est. upside ${money(row.expected_upside)}`,
      `est. cost ${money(row.expected_cost)}`,
      `est. ${row.expected_time_hours}h`,
    ])
  );

  return lines.join("\n").trimEnd();
}

export function renderProposalDetail(
  row: ProposalRow,
  ctx: {
    goalTitle?: string | null;
    outcome?: OutcomeLike | null;
    spend?: ProposalSpend;
    actCalls?: number;
  } = {}
): string {
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);

  push(
    `# Proposal #${row.id} · ${row.domain}`,
    meta([
      row.status,
      `${row.priority} priority`,
      `created ${day(row.created_at)}`,
      row.decided_at ? `decided ${day(row.decided_at)}` : false,
      ctx.goalTitle ? `goal: ${ctx.goalTitle}` : false,
      row.review_status ?? false,
    ])
  );

  // Whether the approved work finished comes before what it planned to do: a proposal whose
  // act phase stopped halfway is a different thing to read than one that never ran.
  if (row.act_status) {
    push("", `## Act phase`, `Status: ${row.act_status}`);
    const problems = parseProblems(row.act_problems);
    if (problems.length > 0) push("", "What the verifier objected to:", ...problems.map((p) => `- ${p}`));
  }

  push("", "## Description", row.description.trim());

  if (row.original_description && row.original_description !== row.description) {
    push(
      "",
      "### Before a human edited the scope",
      "What the model originally asked for:",
      "",
      row.original_description.trim()
    );
  }

  const tools = parseToolList(row.required_tools);
  if (tools.length > 0) {
    push("", "## Fence (required_tools)", ...tools.map((t) => `- ${shortTool(t)} — ${toolRisk(t)}`));
    const original = parseToolList(row.original_required_tools);
    if (original.length > 0) {
      push("", `Originally requested: ${original.map(shortTool).join(", ")}`);
    }
  }

  const m = parseMonetization(row);
  if (row.revenue_model || m) {
    push("", "## Money", `Revenue model: ${row.revenue_model ?? "unstated"}`);
    if (m) {
      push(
        `Who pays: ${m.whoPays}`,
        `Price point: ${m.pricePoint}`,
        `Path to first dollar: ${m.pathToFirstDollar}`,
        `Days to first dollar: ${m.daysToFirstDollar}`,
        `Key assumption: ${m.keyAssumption}`,
        `Validation signal: ${m.validationSignal}`
      );
    }
  }

  push(
    "",
    "## Estimates",
    meta([
      `upside ${money(row.expected_upside)}`,
      `cost ${money(row.expected_cost)}`,
      `${row.expected_time_hours}h`,
    ])
  );

  const steps = parseSteps(row);
  if (steps.length > 0) {
    push("", "## Steps");
    steps.forEach((s, i) => {
      push(
        `${i + 1}. ${s.title}`,
        `   ${meta([`owner: ${s.owner}`, s.tool ? `tool: ${shortTool(s.tool)}` : false])}`,
        `   done when: ${s.doneWhen}`
      );
    });
  }

  if (row.scheduled_at || row.next_run_at || row.recurrence_ms) {
    push(
      "",
      "## Schedule",
      meta([
        row.scheduled_at ? `scheduled ${row.scheduled_at}` : false,
        row.next_run_at ? `next run ${row.next_run_at}` : false,
        row.recurrence_ms ? `repeats every ${Math.round(row.recurrence_ms / 60000)} min` : false,
      ])
    );
  }

  if (row.human_notes) push("", "## Human notes", row.human_notes.trim());

  if (ctx.outcome) {
    push(
      "",
      "## Outcome",
      meta([
        ctx.outcome.success ? "success" : "failure",
        `revenue ${money(ctx.outcome.actual_revenue)}`,
        `cost ${money(ctx.outcome.actual_cost)}`,
        `${ctx.outcome.actual_time_hours}h`,
        `recorded ${day(ctx.outcome.recorded_at)}`,
      ])
    );
    if (ctx.outcome.notes) push("", ctx.outcome.notes.trim());
  }

  if (ctx.spend || ctx.actCalls != null) {
    push(
      "",
      "## What it cost to produce",
      meta([
        ctx.spend ? `${money(ctx.spend.costUsd)} model API spend over ${ctx.spend.phases} phases` : false,
        ctx.actCalls != null ? `${ctx.actCalls} act-phase tool calls` : false,
      ])
    );
  }

  return out.join("\n").trimEnd();
}

// ---- deliverables ---------------------------------------------------------

export function renderDeliverable(d: Deliverable): string {
  const lines = [
    `## ${d.name ?? d.domain} · proposal #${d.proposalId}`,
    meta([
      // First, because a card is built from whatever write tool succeeded, which is not the
      // same as a finished build -- an empty repo would otherwise read as shipped.
      d.actStatus ? `act: ${d.actStatus}` : false,
      d.reviewStatus ?? false,
      `${d.priority} priority`,
      `${d.commits} commits`,
      `${d.filesCommitted} files`,
      `${d.actionCount} act calls`,
      `last activity ${day(d.lastActivityAt)}`,
    ]),
    "",
    preview(d.description, 300),
  ];

  if (d.artifacts.length > 0) {
    lines.push("", "Artifacts:");
    for (const a of d.artifacts) {
      lines.push(`- ${a.kind} · ${a.provider} · ${a.label}${a.detail ? ` (${a.detail})` : ""} — ${a.url}`);
    }
  } else {
    lines.push("", "No browsable artifact — this build wrote nothing that returned a URL.");
  }

  if (d.outcome) {
    lines.push(
      "",
      meta([
        d.outcome.success ? "outcome: success" : "outcome: failure",
        `revenue ${money(d.outcome.revenue)}`,
        `cost ${money(d.outcome.cost)}`,
        `recorded ${day(d.outcome.recordedAt)}`,
      ])
    );
    if (d.outcome.notes) lines.push("", d.outcome.notes.trim());
  }

  return lines.join("\n").trimEnd();
}

// ---- notes and lessons ----------------------------------------------------

export interface NoteLike {
  id: number;
  topic: string;
  finding: string;
  source: string | null;
  confidence: number | null;
  fetched_at: string;
  goal_id: number | null;
  kind: string | null;
}

export interface LessonLike {
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

export function renderNote(row: NoteLike, goals: Map<number, string>): string {
  const score = scoreOf(row);
  const head = meta([
    `#${row.id}`,
    day(row.fetched_at),
    row.goal_id != null ? `goal: ${goals.get(row.goal_id) ?? row.goal_id}` : undefined,
    row.kind ? `kind: ${row.kind}` : undefined,
    row.confidence != null ? `confidence: ${row.confidence}` : undefined,
    score != null ? `relevance: ${score.toFixed(3)}` : undefined,
  ]);
  const source = row.source ? `\n\nSource: ${row.source}` : "";
  return `## ${row.topic}\n${head}\n\n${row.finding}${source}`.trimEnd();
}

export function renderLesson(row: LessonLike, goals: Map<number, string>): string {
  const score = scoreOf(row);
  const head = meta([
    `#${row.id}`,
    day(row.updated_at),
    row.goal_id != null ? `goal: ${goals.get(row.goal_id) ?? row.goal_id}` : undefined,
    `confidence: ${row.confidence.toFixed(2)}`,
    `reinforced ${row.times_reinforced}x / contradicted ${row.times_contradicted}x`,
    row.edited_at ? "human-edited" : undefined,
    score != null ? `relevance: ${score.toFixed(3)}` : undefined,
  ]);
  return `## ${row.domain}\n${head}\n\n${row.lesson}`.trimEnd();
}
