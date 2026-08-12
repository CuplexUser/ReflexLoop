// src/reactive-triggers.ts
//
// Bridges human UI actions to the orchestrator when something should make the
// agent react promptly instead of waiting for the next research+plan cycle.
// One-way, fire-and-forget (no response needed) -- symmetric to
// review-gateway.ts, which bridges the opposite direction (orchestrator waits
// on the API to resolve a decision).

import { EventEmitter } from "node:events";

export interface Trigger {
  proposalId: number;
  reason: "needs_refinement";
}

const bus = new EventEmitter();
bus.setMaxListeners(20);

export function fireReactiveTrigger(trigger: Trigger): void {
  bus.emit("trigger", trigger);
}

export function onReactiveTrigger(listener: (trigger: Trigger) => void): void {
  bus.on("trigger", listener);
}
