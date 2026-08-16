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
  | { type: "phase_start"; phase: string; proposalId: number | null }
  | { type: "tool_call"; phase: string; proposalId: number | null; toolName: string; input: unknown }
  | { type: "model_text"; phase: string; proposalId: number | null; text: string }
  | { type: "phase_done"; phase: string; proposalId: number | null; costUsd: number; durationMs: number }
  | { type: "proposal_pending"; proposal: ProposalRow }
  | { type: "proposal_decided"; proposal: ProposalRow }
  | { type: "proposal_scheduled"; proposal: ProposalRow }
  | { type: "scheduled_run_starting"; proposal: ProposalRow }
  | { type: "outcome_recorded"; proposalId: number }
  | { type: "lesson_saved"; domain: string }
  // A research cycle that proposes nothing is a legitimate outcome, but it used to be
  // indistinguishable from a broken loop: stdout said "No proposal this cycle" and the
  // console showed nothing at all between phase_done and cycle_idle. `toolCalls` is
  // carried because zero of them means something different -- the phase never researched
  // anything, which is a failure, not a decision.
  | { type: "no_proposal"; reason: string; toolCalls: number }
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
