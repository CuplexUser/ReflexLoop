// src/review-gateway.ts
//
// Bridges humanReviewPhase (in orchestrator.ts) to the web UI. The agent
// process calls waitForDecision() and blocks; the API server calls
// submitDecision() when a person clicks Approve/Reject. No polling, no
// files -- just a promise resolver kept in memory for as long as an
// idea is genuinely pending.

export interface Decision {
  approved: boolean;
  /** On a rejection, the reason. On an approval, the operator's focus questions for the deep dive. */
  notes?: string;
  /** Only meaningful when approved -- human-set at decision time, never by the model. */
  priority?: "low" | "normal" | "high" | "urgent";
  scheduledAt?: string | null;
  recurrenceMs?: number | null;
  /** The operator's rewrite of the idea, applied just before approval; the deep dive investigates this. */
  editedDescription?: string;
}

const pendingResolvers = new Map<number, (decision: Decision) => void>();

export function waitForDecision(proposalId: number): Promise<Decision> {
  return new Promise((resolve) => {
    pendingResolvers.set(proposalId, resolve);
  });
}

export function submitDecision(proposalId: number, decision: Decision): boolean {
  const resolve = pendingResolvers.get(proposalId);
  if (!resolve) return false;
  pendingResolvers.delete(proposalId);
  resolve(decision);
  return true;
}

export function hasPendingDecision(proposalId: number): boolean {
  return pendingResolvers.has(proposalId);
}
