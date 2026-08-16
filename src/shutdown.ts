// src/shutdown.ts
//
// Stopping cleanly. Without this, Ctrl-C is indistinguishable from `kill -9`: not one `finally`
// in the process runs, and every one of them is load-bearing.
//
//   - `runPhase` writes the run's cost to the ledger in a finally, specifically so an aborted
//     phase still accounts for what it spent. Killed outright, a research cycle's spend simply
//     vanishes -- the money left the account and the Economics page never hears about it.
//   - `drainQueue` clears `next_run_at` in a finally. Killed outright, the proposal still reads
//     as due and its act phase re-runs from the top on the next start.
//   - `actPhase` records its verdict after the run returns, so the row stays `running` and only
//     the next startup's reap corrects it.
//
// The goal is emphatically *not* to let the work finish -- an act phase can run half an hour.
// It's to interrupt it in a way that lets the unwinding code execute, so the database ends up
// describing what actually happened.
//
// Written against injected dependencies rather than reaching into the orchestrator's module
// state, the same shape as agent-control.ts and settings.ts, because the ordering here is the
// part worth testing and a signal handler is not something a test can fire on Windows (Node
// emulates SIGINT there as unconditional termination -- only a real console Ctrl-C is
// catchable, which is exactly why this logic needs to be reachable without one).

export interface ShutdownDeps {
  /** Stop the scheduler tick, so nothing new is queued while we wind down. */
  stopScheduler(): void;
  /** Stop accepting HTTP/WebSocket connections. */
  closeServer(): void;
  /** Abort every in-flight phase: the shared research/reflect signal and any running act phase. */
  abortPhases(): void;
  /** Resolve the cycle sleep early so the main loop can notice it should stop. */
  wakeLoop(): void;
  /** True while any phase is still unwinding (writing its ledger row, clearing its schedule). */
  inFlight(): boolean;
  /** Close every database handle. */
  closeHandles(): void;
  log(message: string): void;
  warn(message: string): void;
  exit(code: number): void;
  delay(ms: number): Promise<void>;
  now(): number;
  /** How long to wait for in-flight phases before closing anyway. */
  graceMs: number;
}

/**
 * Builds the signal handler. The returned function is safe to call from several signals at
 * once; the second call is treated as the operator saying they don't want to wait.
 */
export function createShutdown(deps: ShutdownDeps): (reason: string) => Promise<void> {
  let shuttingDown = false;

  return async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) {
      // A shutdown that ignores a second Ctrl-C is worse than an unclean one: the operator has
      // no way left to stop the process short of killing it, which is what they were trying to
      // avoid. 130 is the conventional code for "terminated by Ctrl-C".
      deps.warn("[shutdown] second signal -- exiting now, without waiting.");
      deps.exit(130);
      return;
    }
    shuttingDown = true;
    deps.log(`[shutdown] ${reason}. Stopping cleanly; press Ctrl-C again to force.`);

    // Order matters: stop taking on new work before interrupting what's running, or the
    // scheduler can queue a proposal into the gap and start an act phase we're about to abort.
    deps.stopScheduler();
    deps.closeServer();
    deps.wakeLoop();
    deps.abortPhases();

    // The abort propagates into the in-flight fetch, so this is normally milliseconds. The
    // bound is for the case where a tool handler is mid-call and can't be interrupted.
    const deadline = deps.now() + deps.graceMs;
    while (deps.inFlight() && deps.now() < deadline) {
      await deps.delay(100);
    }
    if (deps.inFlight()) {
      deps.warn(
        `[shutdown] still unwinding after ${Math.round(deps.graceMs / 1000)}s; closing anyway. An act phase left marked 'running' is reaped on the next start.`
      );
    }

    deps.closeHandles();
    deps.log("[shutdown] database closed. Bye.");
    deps.exit(0);
  };
}

/**
 * SIGBREAK is here for Windows, where it is what Ctrl-Break sends. SIGTERM never arrives there
 * but costs nothing to listen for, and this runs on both platforms.
 */
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK"] as const;
