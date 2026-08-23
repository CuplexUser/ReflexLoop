// src/mcp/render.test.ts
//
// The MCP server's rendering layer is pure functions over rows, like deliverables.ts and
// act-verification.ts, so it tests without a database file or an API key. What's covered is
// the handful of things that are easy to get wrong and invisible until a client shows the
// wrong thing to a human: a legacy row rendering as a row of dashes instead of as silence,
// an unfinished build reading as shipped, a suggested goal reading as an accepted one, and
// a goal title that matches two lanes resolving to one of them.

import { describe, expect, it } from "vitest";
import {
  renderDeliverable,
  renderGoal,
  renderProposalDetail,
  renderProposalSummary,
  resolveGoal,
  shortTool,
} from "./render.js";
import type { GoalRow, ProposalRow } from "../memory-server.js";
import type { Deliverable } from "../deliverables.js";

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
      outcomes: 1,
      successes: 0,
      api_spend: 1.25,
      last_proposal_at: "2026-08-10T00:00:00.000Z",
      empty_cycles: 3,
    });
    expect(text).toContain("Research in Swedish. Check Fortnox and Bokio first.");
    expect(text).toContain("$1.25 model API spend");
    expect(text).toContain("3 empty cycles since");
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
    expect(text).toContain("act: incomplete");
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
    // The fence is on every proposal, legacy or not -- it's what approval granted.
    expect(text).toContain("- github_create_repo — write");
    expect(text).toContain("- WebSearch — read");
  });

  it("leads with the act verdict, then the plan, then what it cost", () => {
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
    expect(text.indexOf("## Act phase")).toBeLessThan(text.indexOf("## Description"));
    expect(text).toContain("Status: incomplete");
    expect(text).toContain("- Step 1 named github_commit_files, which never ran.");
    expect(text).toContain("Price point: $9/mo");
    expect(text).toContain("   owner: human");
    expect(text).toContain("   owner: agent · tool: github_create_repo");
    expect(text).toContain("failure · revenue $0.00");
    expect(text).toContain("$0.42 model API spend over 3 phases · 2 act-phase tool calls");
  });
});

describe("renderDeliverable", () => {
  const base: Deliverable = {
    proposalId: 27,
    domain: "machine monitoring",
    description: "A machine-status dashboard.",
    name: "CuplexUser/machwatch",
    reviewStatus: null,
    actStatus: "interrupted",
    priority: "normal",
    artifacts: [],
    siteUrl: null,
    repoUrl: "https://github.com/CuplexUser/machwatch",
    filesCommitted: 0,
    commits: 0,
    actionCount: 1,
    startedAt: "2026-08-10T09:00:00.000Z",
    lastActivityAt: "2026-08-10T09:05:00.000Z",
    outcome: null,
  };

  it("says the build stopped before it says what it produced", () => {
    const text = renderDeliverable({
      ...base,
      artifacts: [
        {
          kind: "repo",
          provider: "github",
          label: "CuplexUser/machwatch",
          url: "https://github.com/CuplexUser/machwatch",
          detail: null,
          occurredAt: "2026-08-10T09:05:00.000Z",
          actionId: 501,
        },
      ],
    });
    expect(text.indexOf("act: interrupted")).toBeLessThan(text.indexOf("https://github.com"));
    expect(text).toContain("- repo · github · CuplexUser/machwatch — https://github.com/CuplexUser/machwatch");
  });

  it("says so plainly when a build produced no browsable artifact", () => {
    expect(renderDeliverable(base)).toContain("No browsable artifact");
  });
});
