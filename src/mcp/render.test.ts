// src/mcp/render.test.ts
//
// The MCP server's rendering layer is pure functions over rows, like deep-dive.ts and
// landscape.ts, so it tests without a database file or an API key. What's covered is the
// handful of things that are easy to get wrong and invisible until a client shows the wrong
// thing to a human: a legacy row rendering as a row of dashes instead of as silence, a
// report's verdict buried under its reasoning, a suggested goal reading as an accepted one,
// and a goal title that matches two lanes resolving to one of them.

import { describe, expect, it } from "vitest";
import {
  renderGoal,
  renderProposalDetail,
  renderProposalSummary,
  renderReport,
  renderReportSummary,
  resolveGoal,
  shortTool,
} from "./render.js";
import type { GoalRow, ProposalRow, ReportRow } from "../memory-server.js";

const goal = (over: Partial<GoalRow> & Pick<GoalRow, "id" | "title">): GoalRow => ({
  brief: "",
  status: "active",
  weight: 1,
  origin: "human",
  parent_id: null,
  rationale: null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  ...over,
});

/** A proposal as it looks before the monetization block existed: every added column NULL. */
const legacyProposal: ProposalRow = {
  id: 15,
  domain: "affiliate comparison site",
  goal_id: null,
  description: "Build a comparison site for property management software.",
  expected_cost: 20,
  expected_time_hours: 6,
  expected_upside: 500,
  // Comma-separated, which is how the column really stores it -- not JSON.
  required_tools: "mcp__integrations__github_create_repo,WebSearch",
  status: "approved",
  human_notes: null,
  created_at: "2026-07-01T09:00:00.000Z",
  decided_at: "2026-07-01T10:00:00.000Z",
  review_status: null,
  priority: "normal",
  scheduled_at: null,
  recurrence_ms: null,
  next_run_at: null,
  original_required_tools: null,
  original_description: null,
  revenue_model: null,
  monetization_json: null,
  steps_json: null,
  act_status: null,
  act_problems: null,
  market_json: null,
};

const researchIdea: ProposalRow = {
  ...legacyProposal,
  id: 31,
  required_tools: "",
  revenue_model: "deferred",
  monetization_json: JSON.stringify({
    whoPays: "teams that adopt the free tool",
    pricePoint: "$20/seat/mo for the hosted version",
    pathToFirstDollar: "hosted tier once 500 self-hosted installs exist",
    daysToFirstDollar: 180,
    keyAssumption: "self-hosters become hosted buyers",
    validationSignal: "500 installs",
  }),
  market_json: JSON.stringify({
    marketSize: "~12k teams (estimate from GitHub topic counts)",
    demandEvidence: [{ claim: "recurring requests on the forum", sourceUrl: "https://example.com/thread" }],
    competitors: [{ name: "Acme", pricing: "$30/seat" }],
    keyRisks: ["incumbents bundle it for free"],
    viabilityScore: 4,
    confidence: "medium",
  }),
  steps_json: JSON.stringify([
    { title: "Publish the free tool", doneWhen: "listed on two directories" },
    { title: "Open the hosted waitlist", doneWhen: "100 signups" },
  ]),
};

const fullProposal: ProposalRow = {
  ...legacyProposal,
  id: 27,
  goal_id: 3,
  revenue_model: "subscription",
  monetization_json: JSON.stringify({
    whoPays: "small landlords",
    pricePoint: "$9/mo",
    pathToFirstDollar: "ship the site, run one ad",
    daysToFirstDollar: 14,
    keyAssumption: "landlords search for this",
    validationSignal: "10 signups in a week",
  }),
  steps_json: JSON.stringify([
    { title: "Create the repo", owner: "agent", tool: "mcp__integrations__github_create_repo", doneWhen: "repo exists" },
    { title: "Point the domain", owner: "human", doneWhen: "DNS resolves" },
  ]),
  act_status: "incomplete",
  act_problems: JSON.stringify(["Step 1 named github_commit_files, which never ran."]),
};

describe("resolveGoal", () => {
  const goals = [
    goal({ id: 1, title: "Swedish micro-SaaS" }),
    goal({ id: 2, title: "Affiliate comparison sites" }),
    goal({ id: 3, title: "Affiliate directories", status: "retired" }),
  ];

  it("matches a title exactly, case-insensitively", () => {
    expect(resolveGoal(goals, "swedish micro-saas").id).toBe(1);
  });

  it("accepts a substring when only one goal has it", () => {
    expect(resolveGoal(goals, "comparison").id).toBe(2);
  });

  it("refuses an ambiguous substring and names every goal", () => {
    expect(() => resolveGoal(goals, "affiliate")).toThrow(/matches 2 goals/);
    expect(() => resolveGoal(goals, "affiliate")).toThrow(/Affiliate directories \(retired\)/);
  });

  it("answers a miss with the vocabulary that does exist", () => {
    expect(() => resolveGoal(goals, "crypto")).toThrow(/No goal matching "crypto"/);
    expect(() => resolveGoal(goals, "crypto")).toThrow(/Swedish micro-SaaS \(active\)/);
  });
});

describe("shortTool", () => {
  it("strips the namespace for display only", () => {
    expect(shortTool("mcp__integrations__github_create_repo")).toBe("github_create_repo");
    expect(shortTool("mcp__memory__lesson_search")).toBe("lesson_search");
    expect(shortTool("WebSearch")).toBe("WebSearch");
  });
});

describe("renderGoal", () => {
  it("says a suggested goal is inert until a human accepts it", () => {
    const text = renderGoal(goal({ id: 9, title: "Newsletter sponsorships", status: "suggested", origin: "agent", rationale: "The Swedish lane keeps coming up empty." }));
    expect(text).toContain("Rationale: The Swedish lane keeps coming up empty.");
    expect(text).toMatch(/inert/i);
    expect(text).toMatch(/accepts it in the console/);
  });

  it("renders health when there is any, and the brief verbatim", () => {
    const text = renderGoal(goal({ id: 3, title: "Affiliate comparison sites", brief: "Research in Swedish. Check Fortnox and Bokio first." }), {
      goal_id: 3,
      title: "Affiliate comparison sites",
      status: "active",
      weight: 1,
      proposals: 4,
      approved: 2,
      shipped: 1,
      deep_dives: 2,
      outcomes: 1,
      successes: 0,
      api_spend: 1.25,
      last_proposal_at: "2026-08-10T00:00:00.000Z",
      empty_cycles: 3,
    });
    expect(text).toContain("Research in Swedish. Check Fortnox and Bokio first.");
    expect(text).toContain("$1.25 model API spend");
    expect(text).toContain("3 empty cycles since");
    expect(text).toContain("2 deep-dived");
    expect(text).toContain("1 built (legacy)");
  });
});

describe("renderProposalSummary", () => {
  it("renders no money line at all for a proposal filed before the block existed", () => {
    const text = renderProposalSummary(legacyProposal, new Map());
    expect(text).not.toContain("Money:");
    expect(text).not.toContain("--");
    expect(text).toContain("est. upside $500.00");
  });

  it("renders the money path when there is one", () => {
    const text = renderProposalSummary(fullProposal, new Map([[3, "Affiliate comparison sites"]]), 3);
    expect(text).toContain("Money: subscription · $9/mo · first dollar in 14 days");
    expect(text).toContain("goal: Affiliate comparison sites");
    expect(text).toContain("deep dive: incomplete");
  });

  it("shows the research score and the report verdict for a research-mode idea", () => {
    const text = renderProposalSummary(researchIdea, new Map(), null, {
      id: 4,
      proposal_id: 31,
      verdict: "maybe",
      viability_score: 3,
      confidence: "medium",
      summary: "Promising if the buyers are reachable.",
      created_at: "2026-10-01T00:00:00.000Z",
    });
    expect(text).toContain("research score 4/5");
    expect(text).toContain("report: maybe 3/5");
    expect(text).not.toContain("deep dive:");
  });
});

describe("renderProposalDetail", () => {
  it("omits every section a legacy row has no data for", () => {
    const text = renderProposalDetail(legacyProposal);
    expect(text).not.toContain("## Money");
    expect(text).not.toContain("## Steps");
    expect(text).not.toContain("## Act phase");
    expect(text).not.toContain("## Outcome");
    expect(text).not.toContain("## Schedule");
    expect(text).not.toContain("## Market");
    // A legacy build-mode fence is still shown, plainly -- those tools no longer exist.
    expect(text).toContain("## Legacy build-mode tool fence\ngithub_create_repo, WebSearch");
  });

  it("renders a research-mode idea's market read and launch outline, with no fence", () => {
    const text = renderProposalDetail(researchIdea);
    expect(text).toContain("viability 4/5 · medium confidence");
    expect(text).toContain("- recurring requests on the forum (https://example.com/thread)");
    expect(text).toContain("- Acme · $30/seat");
    expect(text).toContain("## Launch outline");
    expect(text).not.toContain("owner:");
    expect(text).not.toContain("fence");
  });

  it("leads with the verdict, then the plan, then what it cost", () => {
    const text = renderProposalDetail(fullProposal, {
      goalTitle: "Affiliate comparison sites",
      outcome: {
        proposal_id: 27,
        actual_revenue: 0,
        actual_cost: 0,
        actual_time_hours: 1,
        success: 0,
        notes: "Repo created, nothing committed.",
        recorded_at: "2026-08-11T00:00:00.000Z",
      },
      spend: { costUsd: 0.42, phases: 3 },
      actCalls: 2,
    });
    expect(text.indexOf("## Act phase (legacy build mode)")).toBeLessThan(text.indexOf("## Description"));
    expect(text).toContain("Status: incomplete");
    expect(text).toContain("- Step 1 named github_commit_files, which never ran.");
    expect(text).toContain("Price point: $9/mo");
    expect(text).toContain("   owner: human");
    expect(text).toContain("   owner: agent · tool: github_create_repo");
    expect(text).toContain("failure · revenue $0.00");
    expect(text).toContain("$0.42 model API spend over 3 phases · 2 deep-dive tool calls");
  });
});

describe("reports", () => {
  const report: ReportRow = {
    id: 4,
    proposal_id: 31,
    goal_id: 3,
    verdict: "drop",
    viability_score: 2,
    confidence: "high",
    summary: "Incumbents give it away free.",
    body: "## Summary\nIncumbents give it away free.\n\n## Competitors\n- Acme",
    sources_json: JSON.stringify([{ title: "Acme pricing", url: "https://acme.example/pricing" }]),
    created_at: "2026-10-02T00:00:00.000Z",
  };

  it("leads a summary with the verdict", () => {
    const text = renderReportSummary({
      ...report,
      proposal_domain: "dev tools",
      proposal_description: "**Hosted widget** -- a widget",
      goal_title: "Developer tools",
    });
    expect(text).toContain("drop · viability 2/5 · high confidence · 2026-10-02 · goal: Developer tools");
    expect(text.indexOf("drop")).toBeLessThan(text.indexOf("Incumbents"));
  });

  it("renders the full body and every source", () => {
    const text = renderReport(report, { ideaHeadline: "**Hosted widget**", goalTitle: "Developer tools" });
    expect(text).toContain("Idea: Hosted widget");
    expect(text).toContain("## Competitors\n- Acme");
    expect(text).toContain("- Acme pricing — https://acme.example/pricing");
  });
});
