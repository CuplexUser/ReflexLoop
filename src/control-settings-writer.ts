// src/control-settings-writer.ts
//
// The one write path console-only mode has.
//
// `npm run start:console` opens the database read-only precisely so that nothing it does can
// change a row -- SQLite refuses the write, and server.ts refuses the request, and neither
// depends on the other being right. Making the operator's knobs settable there could not be
// done by relaxing the store to read/write: that single change would put every proposal,
// lesson, action and outcome one forgotten `if` away from being editable by a mode whose
// entire promise is that it writes nothing.
//
// So the store stays read-only exactly as it was, and this is a *separate* connection whose
// entire vocabulary is three keys of one table. Two connections to one file in one process is
// ordinary SQLite. What matters is that the capability is the small thing rather than the
// large one: there is no statement in this module that can touch any other table, so no
// future edit to server.ts can accidentally reach one.
//
// Deliberately narrower than `MemoryStore.saveControlSettings`, which the real run uses and
// which persists `directive` as well: a directive is a steer for a research cycle, and a
// process that runs no research cycle has no business queueing one.

import { DatabaseSync } from "node:sqlite";
import type { PersistedControl } from "./memory-server.js";

/**
 * The keys console-only mode may persist -- domains, cycle interval, and the pause switch.
 * Each is a setting for the *next* real run, which is the point: it's the console's answer to
 * "retarget the loop before starting it". `directive` is excluded on purpose (see above), and
 * the API refuses that route in this mode too -- this is the second of the two layers.
 */
const WRITABLE_KEYS = new Set(["domains", "cycleIntervalMs", "paused"]);

/** The API routes the above corresponds to. server.ts allows exactly these in console-only mode. */
export const CONSOLE_ONLY_WRITABLE_ROUTES = ["/control/domains", "/control/interval", "/control/pause"];

export class ControlSettingsWriter {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // The real store creates this table too; repeating it here means the writer doesn't
    // depend on load order, and `IF NOT EXISTS` makes it a no-op on every existing DB.
    this.db.exec(`CREATE TABLE IF NOT EXISTS control_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
  }

  /** Upserts the writable keys of a patch and silently ignores anything else. */
  save(patch: PersistedControl): void {
    const stmt = this.db.prepare(
      `INSERT INTO control_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    const at = new Date().toISOString();
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !WRITABLE_KEYS.has(key)) continue;
      stmt.run(key, JSON.stringify(value), at);
    }
  }

  close(): void {
    this.db.close();
  }
}
