// src/events.ts
//
// In-process event bus. runPhase/humanReviewPhase emit these as the agent
// works; server.ts rebroadcasts them verbatim over WebSocket to the UI.
// Nothing here persists state -- SQLite (memory-server.ts) is still the
// source of truth, this is just the live narration layer on top of it.

import { EventEmitter } from "node:events";
import type { ProposalRow } from "./memory-server.js";

export type AgentEvent =
  | { type: "run_started"; domains: string[] }
  // `run_started` fires exactly once, at process startup -- it is not "a cycle began". A goal
  // added/paused/reactivated from the console changes `getControlState().domains` immediately
  // (see server.ts's `refreshGoals`), but with no event for that the console's own lane badge had
  // no way to learn about it short of a restart. This is that signal.
  | { type: "domains_changed"; domains: string[] }
  | { type: "phase_start"; phase: string; proposalId: number | null }
  | { type: "tool_call"; phase: string; proposalId: number | null; toolName: string; input: unknown }
  | { type: "model_text"; phase: string; proposalId: number | null; text: string }
  | { type: "phase_done"; phase: string; proposalId: number | null; costUsd: number; durationMs: number }
  // A phase's model failed and the next model in its chain took over (llm/failover.ts). Surfaced
  // because a failover that only reached stdout would hide a broken primary indefinitely: the
  // phases would keep finishing, just on a model the Settings page doesn't lead with.
  | { type: "llm_failover"; phase: string; proposalId: number | null; from: string; to: string; error: string }
  | { type: "proposal_pending"; proposal: ProposalRow }
  | { type: "proposal_decided"; proposal: ProposalRow }
  | { type: "proposal_scheduled"; proposal: ProposalRow }
  | { type: "scheduled_run_starting"; proposal: ProposalRow }
  // Legacy: emitted by build-mode act phases. No longer emitted, but kept in the union so
  // persisted events still type-check when the console replays the feed.
  | { type: "outcome_recorded"; proposalId: number }
  // A deep dive's one required output landed. The research-mode counterpart of the above.
  | { type: "report_submitted"; proposalId: number; reportId: number; verdict: string; viabilityScore: number }
  | { type: "lesson_saved"; domain: string }
  // A research cycle that proposes nothing is a legitimate outcome, but it used to be
  // indistinguishable from a broken loop: stdout said "No proposal this cycle" and the
  // console showed nothing at all between phase_done and cycle_idle. `toolCalls` is
  // carried because zero of them means something different -- the phase never researched
  // anything, which is a failure, not a decision.
  | { type: "no_proposal"; reason: string; toolCalls: number }
  // The deep-dive counterpart (type name kept from build mode, where it was the act phase's):
  // a deep dive that ended without submitting a report emits `phase_done` exactly like one that
  // did. See deep-dive.ts for how that is decided.
  // `providerStopReason` is the provider's own word for why the model stopped, carried verbatim
  // because it is the one fact that separates "the model gave up" from "the request died
  // upstream" -- and the second machwatch failure could not be told apart without it.
  | {
      type: "act_incomplete";
      proposalId: number;
      problems: string[];
      toolCalls: number;
      stopReason: string;
      providerStopReason?: string;
    }
  // The reflect-phase counterpart to `no_proposal`/`act_incomplete`: a reflect pass that ended
  // without ever calling lesson_search recorded nothing and looked exactly like one that
  // finished normally -- proposal #30's reflect phase did this in 3.3 seconds for $0, with no
  // signal anywhere that it hadn't done its job. `orchestrator.ts`'s reflect nudge gives it two
  // chances to search before this fires, so this means the phase genuinely never looked, not
  // that it looked and decided there was nothing to add.
  | { type: "reflect_incomplete"; proposalId: number; toolCalls: number }
  // The agent pointing at a lane it isn't allowed to enter. Surfaced live because a suggestion
  // sits inert until a human accepts it -- an operator who never sees it is a suggestion that
  // silently does nothing, which is the same as not having the tool.
  | { type: "goal_suggested"; goalId: number; title: string; rationale: string }
  | { type: "cycle_idle"; nextCycleAt: string };

const bus = new EventEmitter();
bus.setMaxListeners(50);

export function emitAgentEvent(event: AgentEvent): void {
  bus.emit("event", event);
}

export function onAgentEvent(listener: (event: AgentEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
