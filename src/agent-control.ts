// src/agent-control.ts
//
// Runtime knobs the operator can turn without an env change and a restart:
// pause/resume the research loop, run a cycle right now, abort an in-flight
// act phase, retarget the domains, and leave a one-shot directive for the next
// research prompt.
//
// Deliberately does NOT let the operator widen what the agent may do. Pausing,
// aborting, and steering research all either reduce activity or change what the
// agent looks into -- none of them touch the approval fence, and a directive
// only ever lands in the research+plan prompt, whose output is still a proposal
// that a human has to approve. Nothing here can cause a side effect on its own.
//
// Same shape as review-gateway.ts and reactive-triggers.ts: in-process state
// plus an event emitter, since the API server and the orchestrator run in one
// process sharing one SQLite connection.

import { EventEmitter } from "node:events";

export interface ControlState {
  /** When true, the research+plan cycle skips its turn. Approved work already queued still runs. */
  paused: boolean;
  domains: string[];
  cycleIntervalMs: number;
  /** One-shot steer for the next research+plan prompt; cleared once consumed. */
  directive: string | null;
  /** Live snapshot for the UI -- set by the orchestrator, not by the API. */
  runningProposalId: number | null;
  queuedProposalIds: number[];
}

/** What `initControl` is handed to write settings through -- the DB, in practice. */
export type ControlPersister = (patch: {
  domains?: string[];
  cycleIntervalMs?: number;
  paused?: boolean;
  directive?: string | null;
}) => void;

const bus = new EventEmitter();
bus.setMaxListeners(20);

const state: ControlState = {
  paused: false,
  domains: [],
  cycleIntervalMs: 0,
  directive: null,
  runningProposalId: null,
  queuedProposalIds: [],
};

// Set once at startup. Kept as an injected callback rather than importing MemoryStore so
// this module stays dependency-free and testable in isolation -- and so it can't grow the
// ability to read anything back out of the DB.
let persist: ControlPersister = () => {};

/**
 * Called once at startup with the resolved starting state: env defaults, overridden by
 * whatever the operator last set in the console (the caller merges the two). Every setter
 * below then writes through `persist`, so a console change survives a restart instead of
 * silently reverting to the env value the next time the process starts.
 */
export function initControl(opts: {
  domains: string[];
  cycleIntervalMs: number;
  paused?: boolean;
  directive?: string | null;
  persist?: ControlPersister;
}): void {
  state.domains = opts.domains;
  state.cycleIntervalMs = opts.cycleIntervalMs;
  state.paused = opts.paused ?? false;
  state.directive = opts.directive ?? null;
  // Assigned last so seeding the initial state doesn't write it straight back out.
  persist = opts.persist ?? (() => {});
}

export function getControlState(): ControlState {
  return { ...state, domains: [...state.domains], queuedProposalIds: [...state.queuedProposalIds] };
}

export function setPaused(paused: boolean): void {
  state.paused = paused;
  persist({ paused });
  bus.emit("changed");
}

export function setDomains(domains: string[]): void {
  state.domains = domains;
  persist({ domains });
  bus.emit("changed");
}

export function setCycleIntervalMs(ms: number): void {
  state.cycleIntervalMs = ms;
  persist({ cycleIntervalMs: ms });
  bus.emit("changed");
}

/** Leaves a steer for the next research+plan run. Overwrites any directive not yet consumed. */
export function setDirective(directive: string | null): void {
  state.directive = directive;
  persist({ directive });
  bus.emit("changed");
}

/**
 * Reads and clears the pending directive -- a directive steers exactly one cycle. The clear
 * is persisted too: a directive that survived a restart must not then survive being used,
 * or it would quietly become the standing instruction it is explicitly not meant to be.
 */
export function consumeDirective(): string | null {
  const directive = state.directive;
  state.directive = null;
  if (directive !== null) {
    persist({ directive: null });
    bus.emit("changed");
  }
  return directive;
}

/** Orchestrator-owned: keeps the UI's view of what's executing honest. */
export function reportExecutionState(runningProposalId: number | null, queuedProposalIds: number[]): void {
  state.runningProposalId = runningProposalId;
  state.queuedProposalIds = queuedProposalIds;
  bus.emit("changed");
}

// ---- one-shot signals ------------------------------------------------------

/** Asks the loop to start a research cycle immediately instead of waiting out the interval. */
export function requestRunNow(): void {
  bus.emit("run-now");
}

export function onRunNow(listener: () => void): void {
  bus.on("run-now", listener);
}

/** Asks the orchestrator to abort the act phase currently executing, if any. */
export function requestAbort(proposalId: number): void {
  bus.emit("abort", proposalId);
}

export function onAbort(listener: (proposalId: number) => void): void {
  bus.on("abort", listener);
}

export function onControlChanged(listener: () => void): void {
  bus.on("changed", listener);
}
