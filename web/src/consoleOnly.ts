import { createContext, useContext } from 'react'

/**
 * True when the backend is `npm run start:console`: the real database served read-only, with
 * the agent loop not running. Provided once by `App` from `GET /api/status` and read wherever
 * a control writes.
 *
 * The point is that the UI refuses the same things the server does, rather than offering every
 * button and letting each one fail with a 403 toast after the click. What stays enabled is
 * exactly the server's allowlist -- domains, cycle interval, and the running switch, the three
 * settings the *next* real run reads at startup. Everything else (approve/reject, scope edits,
 * memory curation, review verdicts, directives, run-now, abort) is disabled with
 * `READ_ONLY_HINT` as the reason, because this process has no loop for them to affect and no
 * writable row to record them in.
 *
 * Keep this in step with CONSOLE_ONLY_WRITABLE_ROUTES in src/control-settings-writer.ts: the
 * server is the enforcement, this is only the honest label on it.
 */
export const ConsoleOnlyContext = createContext(false)

export function useConsoleOnly(): boolean {
  return useContext(ConsoleOnlyContext)
}

export const READ_ONLY_HINT =
  'Read-only console (start:console) — the agent loop is not running. Only domains, cycle interval and the running switch can be changed.'
