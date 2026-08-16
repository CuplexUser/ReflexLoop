import { describe, expect, it } from "vitest";
import { verifyAct, type ActAttempt } from "./act-verification.js";
import type { ProposalStep } from "./memory-server.js";

const ok = (name: string) => ({ name, isError: false });
const failed = (name: string) => ({ name, isError: true });

const attempt = (over: Partial<ActAttempt> = {}): ActAttempt => ({
  toolCalls: [],
  stopReason: "end_turn",
  ...over,
});

/**
 * The plan proposal #27 was approved on, verbatim from `steps_json` (titles shortened).
 * Act created the repo and stopped; this is the case the whole module exists for.
 */
const MACHWATCH_STEPS: ProposalStep[] = [
  {
    title: "Create the public repo CuplexUser/machwatch",
    owner: "agent",
    tool: "mcp__integrations__github_create_repo",
    doneWhen: "repo exists",
  },
  {
    title: "Commit the full prototype in one commit",
    owner: "agent",
    tool: "mcp__integrations__github_commit_files",
    doneWhen: "index.html + README.md + app.js are readable on the default branch",
  },
  {
    title: "Deploy the repo to Vercel",
    owner: "agent",
    tool: "mcp__integrations__vercel_deploy",
    doneWhen: "vercel_get_project('machwatch') returns a project",
  },
  {
    title: "Verify public reachability of the deployed URL",
    owner: "agent",
    tool: "WebFetch",
    doneWhen: "WebFetch either renders the page or returns the SSO redirect",
  },
  {
    title: "Human: click the FormSubmit activation email",
    owner: "human",
    tool: "WebFetch",
    doneWhen: "activation email confirmed",
  },
];

/** The act phase's real tool calls on #27, in order. */
const MACHWATCH_CALLS = [
  ok("mcp__memory__proposal_status"),
  ok("mcp__memory__lesson_search"),
  ok("mcp__memory__lesson_search"),
  ok("mcp__integrations__github_read_repo"),
  ok("mcp__memory__action_history_search"),
  ok("WebSearch"),
  ok("WebSearch"),
  ok("WebSearch"),
  ok("WebFetch"),
  ok("WebFetch"),
  ok("WebSearch"),
  ok("mcp__integrations__github_create_repo"),
  ok("WebSearch"),
];

describe("verifyAct", () => {
  it("catches proposal #27: repo created, nothing committed, nothing deployed, no outcome", () => {
    const verdict = verifyAct(MACHWATCH_STEPS, attempt({ toolCalls: MACHWATCH_CALLS }));

    expect(verdict.complete).toBe(false);
    expect(verdict.outcomeRecorded).toBe(false);
    expect(verdict.unrunSteps.map((s) => s.tool)).toEqual([
      "mcp__integrations__github_commit_files",
      "mcp__integrations__vercel_deploy",
    ]);
    // The human step is the agent's to skip, and the repo/WebFetch steps really did run.
    expect(verdict.unrunSteps.map((s) => s.position)).toEqual([2, 3]);
    expect(verdict.problems.join(" ")).toContain("outcome_record was never called");
  });

  it("passes a run that did every agent step and recorded the outcome", () => {
    const verdict = verifyAct(
      MACHWATCH_STEPS,
      attempt({
        toolCalls: [
          ...MACHWATCH_CALLS,
          ok("mcp__integrations__github_commit_files"),
          ok("mcp__integrations__vercel_deploy"),
          ok("mcp__memory__outcome_record"),
        ],
      })
    );

    expect(verdict).toMatchObject({ complete: true, outcomeRecorded: true, unrunSteps: [], problems: [] });
  });

  it("does not count a tool that returned an in-band error as having run", () => {
    // The shape github_commit_files produced against an empty repo: 409, nothing committed.
    const verdict = verifyAct(
      MACHWATCH_STEPS,
      attempt({
        toolCalls: [
          ...MACHWATCH_CALLS,
          failed("mcp__integrations__github_commit_files"),
          ok("mcp__integrations__vercel_deploy"),
          ok("mcp__memory__outcome_record"),
        ],
      })
    );

    expect(verdict.complete).toBe(false);
    expect(verdict.unrunSteps.map((s) => s.tool)).toEqual(["mcp__integrations__github_commit_files"]);
  });

  it("names the provider's finish reason on a failure, so it doesn't have to be guessed later", () => {
    const verdict = verifyAct(MACHWATCH_STEPS, attempt({ toolCalls: MACHWATCH_CALLS, providerStopReason: "stop" }));
    expect(verdict.problems.at(-1)).toBe('Provider finish_reason on the final turn: "stop".');
  });

  it("does not report a finish reason on a clean run -- it is a diagnostic, not a fault", () => {
    const verdict = verifyAct(
      [],
      attempt({ toolCalls: [ok("mcp__memory__outcome_record")], providerStopReason: "stop" })
    );
    expect(verdict).toMatchObject({ complete: true, problems: [] });
  });

  it("reports truncation separately from the unrun steps it caused", () => {
    const verdict = verifyAct(
      MACHWATCH_STEPS,
      attempt({ toolCalls: MACHWATCH_CALLS, stopReason: "truncated", providerStopReason: "length" })
    );

    expect(verdict.problems[0]).toContain("cut off at the output token limit");
    expect(verdict.problems[0]).toContain("finish_reason=length");
  });

  it("reports running out of turns", () => {
    const verdict = verifyAct([], attempt({ toolCalls: [ok("WebSearch")], stopReason: "max_turns" }));
    expect(verdict.problems).toContain("The phase ran out of turns before it finished.");
  });

  it("distinguishes a phase that never executed from one that executed badly", () => {
    const verdict = verifyAct(MACHWATCH_STEPS, attempt({ toolCalls: [] }));
    expect(verdict.problems.join(" ")).toContain("never started executing");
  });

  it("holds a legacy proposal with no steps to the outcome requirement only", () => {
    // steps_json is null on every proposal written before the monetization block existed.
    expect(verifyAct([], attempt({ toolCalls: [ok("mcp__memory__outcome_record")] })).complete).toBe(true);
    expect(verifyAct([], attempt({ toolCalls: [ok("WebSearch")] })).complete).toBe(false);
  });

  it("ignores human-owned steps and agent steps that declared no tool", () => {
    const steps: ProposalStep[] = [
      { title: "human thing", owner: "human", tool: "mcp__integrations__vercel_deploy", doneWhen: "done" },
      { title: "agent thing with no tool", owner: "agent", doneWhen: "done" },
    ];
    expect(verifyAct(steps, attempt({ toolCalls: [ok("mcp__memory__outcome_record")] })).unrunSteps).toEqual([]);
  });
});
