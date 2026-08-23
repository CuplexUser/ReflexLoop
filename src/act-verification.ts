// src/act-verification.ts
//
// Did the act phase actually do the thing it was approved to do?
//
// Until this existed the answer was never asked. `runPhase` reported a phase as done the
// moment `runAgent` returned, and `runAgent` returns whenever the model stops calling tools
// -- for any reason, including being cut off mid-generation. Proposal #27 is the worked
// example: act created `CuplexUser/machwatch`, spent a turn searching for ISO 10816-3
// threshold values, said "Now I'll write the full prototype", and returned no tool call.
// `github_commit_files` and `vercel_deploy` were both in the fence and never ran,
// `outcome_record` was never called, `outcomes` got no row -- and the loop emitted
// `phase_done`, ran reflect against a nonexistent outcome, and moved on. The repo is still
// empty, and because `github_create_repo` is a DELIVERABLE_TOOL it shows on the Deliverables
// page as something that shipped.
//
// This is the same shape as research's `no_proposal` event: a phase that produced nothing is
// a legitimate thing to report, but it has to be *reported*, not silently indistinguishable
// from a phase that produced everything.
//
// Pure functions over rows, like deliverables.ts -- no store, no API key, unit-testable.

import type { AgentStopReason } from "./agent-loop.js";
import type { ProposalStep } from "./memory-server.js";

const OUTCOME_TOOL = "mcp__memory__outcome_record";

/** What the act phase actually did, as `runPhase` observed it. */
export interface ActAttempt {
  /** Every tool call the phase made, in order. `isError` is the tool's own in-band failure flag. */
  toolCalls: { name: string; isError: boolean }[];
  stopReason: AgentStopReason;
  /** The provider's verbatim finish reason, used only in the human-readable problem text. */
  providerStopReason?: string;
  /**
   * Tools that already ran successfully in an *earlier* act phase on this same proposal
   * (`store.succeededActTools`). A step they cover counts as done.
   *
   * Without this a re-run is judged as though the proposal had never been acted on, which is
   * how #40 -- six files committed, read back, outcome recorded -- was filed `incomplete`: the
   * operator re-ran it, the model correctly saw the repo already existed and skipped step 1,
   * and the verifier called the finished build unfinished. The nudge then pushed it to run
   * `github_create_repo` again, which answers 422 on an existing repo *forever*, so the step
   * was unsatisfiable by construction -- and the retry it did manage was a duplicate commit.
   *
   * Left empty for a **recurring** proposal, where each occurrence is supposed to do the work
   * again and a previous occurrence proves nothing about this one; `actPhase` decides that.
   */
  priorSuccessfulTools?: string[];
}

/** An approved agent-owned step whose declared tool never ran. */
export interface UnrunStep {
  /** 1-based, matching how the plan is numbered in the act prompt and in the console. */
  position: number;
  title: string;
  tool: string;
}

export interface ActVerdict {
  /** True only when the plan ran, the outcome was recorded, and the model finished deliberately. */
  complete: boolean;
  unrunSteps: UnrunStep[];
  outcomeRecorded: boolean;
  /**
   * Human-readable, most important first, and empty exactly when `complete`. This is what
   * goes in the `act_incomplete` event, the synthetic outcome's notes, and reflect's prompt.
   */
  problems: string[];
}

/**
 * Verifies an act phase against the plan the human approved.
 *
 * The check is deliberately **the declared tool of each agent-owned step, not its `doneWhen`
 * prose**. `doneWhen` is free text written by a model -- #27's happened to be checkable
 * ("index.html + README.md + app.js are readable on the default branch") but the next one
 * will not be, and a verifier that parses natural language fails in both directions. The tool
 * name is exact, it is already the thing `proposal_create` cross-checks against
 * `required_tools` at create time, and it is recorded verbatim in `actions.tool_name`. So this
 * is the same invariant one phase later: a step said it needed this tool, the fence was widened
 * to permit it, therefore it must have run.
 *
 * On #27 that catches the failure exactly -- `github_commit_files` and `vercel_deploy` are both
 * declared on agent steps and neither appears in the phase's calls.
 *
 * A call that came back `isError` does not count as having run: the tool reported in-band that
 * it did nothing, which is the case `github_commit_files` hitting `409 Git Repository is empty`
 * used to produce, and counting it would call a failed build complete.
 *
 * Human-owned steps are never counted against the agent -- it has no tool for them by
 * construction, which is why `approvedPlanBrief` marks them as not its to do.
 *
 * A step whose tool succeeded in an earlier act phase on the same proposal counts as done --
 * see `priorSuccessfulTools`. "This attempt did not call it" is not the same as "the work does
 * not exist", and a re-run is the case where those two come apart.
 */
export function verifyAct(steps: ProposalStep[], attempt: ActAttempt): ActVerdict {
  const ranThisAttempt = new Set(attempt.toolCalls.filter((c) => !c.isError).map((c) => c.name));
  // A step is done if its tool succeeded in this run *or* in an earlier one on this proposal.
  // The question the plan asks is whether the work exists, not which process invocation did it.
  const stepDone = new Set([...ranThisAttempt, ...(attempt.priorSuccessfulTools ?? [])]);

  const unrunSteps: UnrunStep[] = steps.flatMap((step, index) =>
    step.owner === "agent" && step.tool && !stepDone.has(step.tool)
      ? [{ position: index + 1, title: step.title, tool: step.tool }]
      : []
  );
  // Deliberately *not* credited from a prior run, unlike the steps above: an outcome describes
  // the run that wrote it, and a re-run that found everything already built still has to say so.
  // Asking for it again is free -- outcome_record writes to the agent's own memory and has no
  // side effect to repeat, which is the whole reason the steps need the carve-out and this
  // doesn't.
  const outcomeRecorded = ranThisAttempt.has(OUTCOME_TOOL);

  const problems: string[] = [];
  if (attempt.stopReason === "truncated") {
    problems.push(
      `The model's final turn was cut off at the output token limit${attempt.providerStopReason ? ` (finish_reason=${attempt.providerStopReason})` : ""} rather than finishing -- it stopped mid-task, not because it was done.`
    );
  }
  if (attempt.stopReason === "max_turns") {
    problems.push("The phase ran out of turns before it finished.");
  }
  if (attempt.toolCalls.length === 0) {
    // Distinguished from the step check below for the same reason `no_proposal` carries a tool
    // count: zero calls means the phase never executed at all, which is a broken model call
    // rather than a build that went wrong partway.
    problems.push("The phase made no tool calls at all -- it never started executing.");
  }
  if (unrunSteps.length > 0) {
    problems.push(
      `${unrunSteps.length} approved step${unrunSteps.length === 1 ? "" : "s"} never ran: ${unrunSteps
        .map((s) => `#${s.position} "${s.title}" (${s.tool})`)
        .join("; ")}.`
    );
  }
  if (!outcomeRecorded) {
    problems.push("outcome_record was never called, so nothing recorded what actually happened.");
  }

  // Appended last, and only to a report that already has something wrong in it, because on its
  // own a finish reason is not a fault -- it's the diagnostic. Threading this all the way here
  // and then dropping it is what made the second machwatch failure another archaeology session:
  // the verdict could say the model stopped, but not a word about what the provider called it,
  // which is the one fact separating "the model gave up" from "the request died upstream".
  if (problems.length > 0 && attempt.providerStopReason) {
    problems.push(`Provider finish_reason on the final turn: "${attempt.providerStopReason}".`);
  }

  return { complete: problems.length === 0, unrunSteps, outcomeRecorded, problems };
}
