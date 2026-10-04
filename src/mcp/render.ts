// src/mcp/render.ts
//
// The pure half of the MCP server: rows in, Markdown out, plus the small lookups that
// turn a human's goal *title* into a goal. Nothing here opens or touches the database,
// which is what lets render.test.ts exercise it without a DB file or an API key -- the
// same stance deep-dive.ts and landscape.ts take.
//
// Everything an MCP client sees is prose, so the formatting decisions here are the
// interface. Two rules run through all of them:
//
//   - A field that is null on legacy rows renders *nothing*, never a dash. Most of these
//     columns (monetization, market, steps, act_status, goal_id) were added to a live
//     database and deliberately not backfilled, so "absent" is the common case, not an
//     anomaly, and a row of dashes reads like a broken record instead of an older one.
//   - A verdict comes before the reasoning behind it. A report opens with pursue/maybe/drop,
//     and an idea's detail says whether its deep dive finished before what it found.

import "../mcp-env.js";
import {
  parseMarket,
  parseMonetization,
  parseSources,
  parseSteps,
  preview,
  type GoalHealthRow,
  type GoalRow,
  type ProposalRow,
  type ReportListRow,
  type ReportRow,
  type ReportSummary,
} from "../memory-server.js";

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
 * because those strings are persisted in actions and in legacy proposals' fences. They're
 * noise to read, so they're stripped for display only -- exactly what the console does.
 */
export const shortTool = (name: string) => name.replace(/^mcp__[a-z_]+__/, "");

/**
 * The legacy build-mode fence, stored comma-separated rather than as JSON --
 * `"WebSearch,mcp__integrations__github_create_repo"`. Empty on every research-mode idea.
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
        `${health.deep_dives} deep-dived`,
        health.shipped > 0 ? `${health.shipped} built (legacy)` : false,
        health.outcomes > 0 ? `${health.outcomes} legacy outcomes (${health.successes} successful)` : false,
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

export function renderProposalSummary(
  row: ProposalRow,
  goals: Map<number, string>,
  goalId?: number | null,
  report?: ReportSummary | null
): string {
  const market = parseMarket(row);
  const head = meta([
    // No `#id` here -- the heading above already carries it.
    row.status,
    `${row.priority} priority`,
    `created ${day(row.created_at)}`,
    market ? `research score ${market.viabilityScore}/5` : false,
    report ? `report: ${report.verdict} ${report.viability_score}/5` : false,
    // Only ever set once an idea has reached its deep dive; absent is the normal state.
    !report && row.act_status ? `deep dive: ${row.act_status}` : false,
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
    report?: ReportSummary | null;
  } = {}
): string {
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);

  push(
    `# Idea #${row.id} · ${row.domain}`,
    meta([
      row.status,
      `${row.priority} priority`,
      `created ${day(row.created_at)}`,
      row.decided_at ? `decided ${day(row.decided_at)}` : false,
      ctx.goalTitle ? `goal: ${ctx.goalTitle}` : false,
      row.review_status ?? false,
    ])
  );

  // The verdict first: what the deep dive concluded, or whether it finished at all.
  if (ctx.report) {
    push(
      "",
      "## Latest deep-dive report",
      meta([
        `report #${ctx.report.id}`,
        ctx.report.verdict,
        `viability ${ctx.report.viability_score}/5`,
        `${ctx.report.confidence} confidence`,
        day(ctx.report.created_at),
      ]),
      "",
      ctx.report.summary.trim(),
      "",
      "Read the whole report with report_get."
    );
  }
  if (row.act_status) {
    const label = row.market_json === null ? "Act phase (legacy build mode)" : "Deep dive";
    push("", `## ${label}`, `Status: ${row.act_status}`);
    const problems = parseProblems(row.act_problems);
    if (problems.length > 0) push("", "What the verifier objected to:", ...problems.map((p) => `- ${p}`));
  }

  push("", "## Description", row.description.trim());

  if (row.original_description && row.original_description !== row.description) {
    push(
      "",
      "### Before a human edited it",
      "What the model originally asked for:",
      "",
      row.original_description.trim()
    );
  }

  const market = parseMarket(row);
  if (market) {
    push(
      "",
      "## Market (research phase)",
      meta([`viability ${market.viabilityScore}/5`, `${market.confidence} confidence`]),
      `Market size: ${market.marketSize}`
    );
    if (market.demandEvidence.length > 0) {
      push("", "Demand evidence:", ...market.demandEvidence.map((d) => `- ${d.claim} (${d.sourceUrl})`));
    }
    if (market.competitors.length > 0) {
      push(
        "",
        "Competitors:",
        ...market.competitors.map(
          (c) => `- ${c.name}${c.url ? ` (${c.url})` : ""}${c.pricing ? ` · ${c.pricing}` : ""}${c.gap ? ` · gap: ${c.gap}` : ""}`
        )
      );
    }
    if (market.keyRisks.length > 0) push("", "Key risks:", ...market.keyRisks.map((r) => `- ${r}`));
  }

  // Only legacy build-mode proposals carry one. Printed plainly: those tool names no longer
  // exist, so there is nothing current to classify them against.
  const tools = parseToolList(row.required_tools);
  if (tools.length > 0) {
    push("", "## Legacy build-mode tool fence", tools.map(shortTool).join(", "));
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
    // A legacy build-mode plan split steps between agent and human; a research-mode launch
    // outline is all the human's, so it has no owner to print.
    const legacy = steps.some((s) => s.owner);
    push("", legacy ? "## Steps" : "## Launch outline");
    steps.forEach((s, i) => {
      push(`${i + 1}. ${s.title}`);
      if (s.owner) push(`   ${meta([`owner: ${s.owner}`, s.tool ? `tool: ${shortTool(s.tool)}` : false])}`);
      push(`   done when: ${s.doneWhen}`);
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

  if (row.human_notes) push("", "## Operator notes", row.human_notes.trim());

  if (ctx.outcome) {
    push(
      "",
      "## Outcome (legacy build mode)",
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
        ctx.actCalls != null ? `${ctx.actCalls} deep-dive tool calls` : false,
      ])
    );
  }

  return out.join("\n").trimEnd();
}

// ---- reports --------------------------------------------------------------

export function renderReportSummary(row: ReportListRow): string {
  const headline = row.proposal_description.split("\n").find((l) => l.trim()) ?? row.proposal_description;
  return [
    `## Report #${row.id} · idea #${row.proposal_id}`,
    meta([
      // The verdict leads: it is the answer, and the rest is why.
      row.verdict,
      `viability ${row.viability_score}/5`,
      `${row.confidence} confidence`,
      day(row.created_at),
      row.goal_title ? `goal: ${row.goal_title}` : false,
    ]),
    "",
    preview(headline.replace(/[*_#`]/g, ""), 200),
    "",
    row.summary.trim(),
  ]
    .join("\n")
    .trimEnd();
}

export function renderReport(row: ReportRow, ctx: { ideaHeadline?: string | null; goalTitle?: string | null } = {}): string {
  const sources = parseSources(row);
  const lines = [
    `# Report #${row.id} · idea #${row.proposal_id}`,
    meta([
      row.verdict,
      `viability ${row.viability_score}/5`,
      `${row.confidence} confidence`,
      day(row.created_at),
      ctx.goalTitle ? `goal: ${ctx.goalTitle}` : false,
    ]),
  ];
  if (ctx.ideaHeadline) lines.push("", `Idea: ${preview(ctx.ideaHeadline.replace(/[*_#`]/g, ""), 200)}`);
  lines.push("", row.summary.trim(), "", row.body.trim());
  if (sources.length > 0) {
    lines.push("", "## Sources", ...sources.map((s) => `- ${s.title} — ${s.url}${s.note ? ` (${s.note})` : ""}`));
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
