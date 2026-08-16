import { describe, expect, it } from "vitest";
import { createShutdown, type ShutdownDeps } from "./shutdown.js";

/**
 * A shutdown is almost entirely about *ordering* -- stop taking work, then interrupt what's
 * running, then wait, then close -- and getting it wrong is silent: the process still exits, it
 * just leaves the record wrong. So the fake records the order and the tests assert on it.
 */
function fakeDeps(over: Partial<ShutdownDeps> = {}) {
  const calls: string[] = [];
  const exits: number[] = [];
  let clock = 0;
  let inFlightTicks = 0;

  const deps: ShutdownDeps = {
    stopScheduler: () => void calls.push("stopScheduler"),
    closeServer: () => void calls.push("closeServer"),
    abortPhases: () => void calls.push("abortPhases"),
    wakeLoop: () => void calls.push("wakeLoop"),
    inFlight: () => inFlightTicks > 0,
    closeHandles: () => void calls.push("closeHandles"),
    log: () => {},
    warn: (m) => void calls.push(`warn:${m.slice(0, 24)}`),
    // Recorded rather than throwing: the real one never returns, and a test that models it as
    // fatal can't check what happens after a forced second signal.
    exit: (code) => void exits.push(code),
    delay: async (ms) => {
      clock += ms;
      inFlightTicks = Math.max(0, inFlightTicks - 1);
    },
    now: () => clock,
    graceMs: 15_000,
    ...over,
  };

  return {
    deps,
    calls,
    exits,
    setInFlight: (ticks: number) => {
      inFlightTicks = ticks;
    },
    elapsed: () => clock,
  };
}

describe("createShutdown", () => {
  it("stops taking new work before interrupting what is running", async () => {
    const f = fakeDeps();
    await createShutdown(f.deps)("SIGINT");

    // The scheduler and the server have to be shut before the abort: otherwise the scheduler
    // can queue a proposal into the gap and start an act phase we are about to kill, which is
    // the one case that creates real side effects with no follow-through.
    expect(f.calls.indexOf("stopScheduler")).toBeLessThan(f.calls.indexOf("abortPhases"));
    expect(f.calls.indexOf("closeServer")).toBeLessThan(f.calls.indexOf("abortPhases"));
    expect(f.calls.indexOf("abortPhases")).toBeLessThan(f.calls.indexOf("closeHandles"));
    expect(f.exits).toEqual([0]);
  });

  it("closes the database only after the last phase has unwound", async () => {
    const f = fakeDeps();
    f.setInFlight(3); // three polls' worth of a phase still writing its ledger row

    let inFlightAtClose = true;
    const deps = { ...f.deps, closeHandles: () => void (inFlightAtClose = f.deps.inFlight()) };
    await createShutdown(deps)("SIGTERM");

    expect(inFlightAtClose).toBe(false);
  });

  it("gives up after the grace period rather than hanging forever", async () => {
    const f = fakeDeps();
    f.setInFlight(Number.MAX_SAFE_INTEGER); // a tool handler that never returns

    await createShutdown(f.deps)("SIGINT");

    expect(f.elapsed()).toBeGreaterThanOrEqual(15_000);
    expect(f.calls.some((c) => c.startsWith("warn:"))).toBe(true);
    expect(f.calls).toContain("closeHandles");
    expect(f.exits).toEqual([0]);
  });

  it("a second signal exits immediately instead of waiting", async () => {
    const f = fakeDeps();
    f.setInFlight(Number.MAX_SAFE_INTEGER);

    const shutdown = createShutdown(f.deps);
    const first = shutdown("SIGINT");
    // Arrives while the first is still in its wait loop.
    await shutdown("SIGINT");

    expect(f.exits).toEqual([130]);
    // The forced exit must not have torn anything down itself -- the first call still owns that.
    expect(f.calls).not.toContain("closeHandles");
    await first;
  });

  it("does not run the teardown twice when several signals arrive", async () => {
    const f = fakeDeps();
    const shutdown = createShutdown(f.deps);

    await shutdown("SIGINT");
    await shutdown("SIGTERM");

    expect(f.calls.filter((c) => c === "closeHandles")).toHaveLength(1);
    expect(f.calls.filter((c) => c === "abortPhases")).toHaveLength(1);
    expect(f.exits).toEqual([0, 130]);
  });
});
