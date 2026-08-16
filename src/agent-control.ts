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

/**
 * The parts of a goal the control layer needs. A structural copy rather than a re-export of
 * `GoalRow`, so this module keeps its promise of not importing MemoryStore -- and so the state
 * the console reads stays a summary rather than growing whatever columns the table grows.
 */
export interface GoalSummary {
  id: number;
  title: string;
  brief: string;
  status: "active" | "paused" | "retired" | "suggested";
  weight: number;
}

export interface ControlState {
  /** When true, the research+plan cycle skips its turn. Approved work already queued still runs. */
  paused: boolean;
  /**
   * Every goal, whatever its status -- including `suggested` ones, which the console needs to
   * show and which the loop must never research. Filter before use; `domains` below is the
   * pre-filtered form the research cycle actually wants.
   */
  goals: GoalSummary[];
  /**
   * Titles of the active goals. Derived from `goals`, not set independently: it used to be the
   * source of truth and is now a projection, so there is no way for the two to disagree about
   * what the loop is pointed at.
   */
  domains: string[];
  cycleIntervalMs: number;
  /** One-shot steer for the next research+plan prompt; cleared once consumed. */
  directive: string | null;
  /** Live snapshot for the UI -- set by the orchestrator, not by the API. */
  runningProposalId: number | null;
  queuedProposalIds: number[];
  /**
   * When the current act phase started, ISO. Derived here rather than passed in, from the
   * transition into a new `runningProposalId` -- the queue view needs an elapsed time and the
   * `runs` row that would carry it isn't written until the phase is over, which is exactly the
   * window where someone is watching and wants to know how long it has been going.
   */
  runningSince: string | null;
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
  goals: [],
  domains: [],
  cycleIntervalMs: 0,
  directive: null,
  runningProposalId: null,
  queuedProposalIds: [],
  runningSince: null,
};

/** A goal is only researched while it's active -- `paused`, `retired` and `suggested` are all out. */
const activeTitles = (goals: readonly GoalSummary[]) => goals.filter((g) => g.status === "active").map((g) => g.title);

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
  goals: GoalSummary[];
  cycleIntervalMs: number;
  paused?: boolean;
  directive?: string | null;
  persist?: ControlPersister;
}): void {
  state.goals = opts.goals;
  state.domains = activeTitles(opts.goals);
  state.cycleIntervalMs = opts.cycleIntervalMs;
  state.paused = opts.paused ?? false;
  state.directive = opts.directive ?? null;
  // Assigned last so seeding the initial state doesn't write it straight back out.
  persist = opts.persist ?? (() => {});
}

export function getControlState(): ControlState {
  return {
    ...state,
    goals: state.goals.map((g) => ({ ...g })),
    domains: [...state.domains],
    queuedProposalIds: [...state.queuedProposalIds],
    runningSince: state.runningSince,
  };
}

export function setPaused(paused: boolean): void {
  state.paused = paused;
  persist({ paused });
  bus.emit("changed");
}

/**
 * Replaces the whole goal set. Called by server.ts after any goal mutation with a fresh read
 * from the DB, rather than being patched incrementally -- the table is the source of truth and
 * a re-read cannot drift from it.
 *
 * `control_settings.domains` is still written, with the active titles. Nothing in the loop reads
 * it any more, but it remains the record a fresh DB seeds goals from, and keeping it current
 * means the seed after a `DELETE FROM goals` reflects what the operator last had rather than
 * whatever AGENT_DOMAINS said months ago.
 */
export function setGoals(goals: GoalSummary[]): void {
  state.goals = goals;
  state.domains = activeTitles(goals);
  persist({ domains: state.domains });
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
  // Only restamped when the running proposal actually changes, so a report that merely updates
  // the queue doesn't reset the elapsed clock on a build that has been going for twenty minutes.
  if (runningProposalId !== state.runningProposalId) {
    state.runningSince = runningProposalId === null ? null : new Date().toISOString();
  }
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
