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
  | { type: "outcome_recorded"; proposalId: number }
  | { type: "lesson_saved"; domain: string }
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
