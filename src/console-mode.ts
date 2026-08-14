// src/console-mode.ts
//
// The console-only flag, on its own with no dependencies, because two unrelated
// modules need it: the orchestrator (open the DB read-only, don't run the loop) and
// server.ts (refuse anything that would write).

/**
 * True when this process should run as a console harness: `npm run start:console`, or
 * AGENT_CONSOLE_ONLY=1. The CLI flag exists because `AGENT_CONSOLE_ONLY=1 npm start`
 * doesn't work on Windows.
 *
 * In this mode the process serves the API and the web console against the real database,
 * opened READ-ONLY, and runs no agent loop at all. So: your real data on screen, no model
 * API called, no token spent, and nothing that can modify a row -- not by the agent, which
 * isn't running, and not by the console, whose write endpoints are refused.
 *
 * Nothing here is mocked or simulated. It is the real database and the real server; the
 * only thing missing is the agent.
 */
export function isConsoleOnlyMode(): boolean {
  const flag = (process.env.AGENT_CONSOLE_ONLY ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || process.argv.includes("--console-only");
}
