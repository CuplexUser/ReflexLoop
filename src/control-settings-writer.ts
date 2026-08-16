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

/**
 * The API routes the above corresponds to. server.ts allows exactly these in console-only mode.
 *
 * Patterns rather than plain strings because the goal routes carry an id. Anchored on both ends
 * and with `\d+` for the id, so this stays an allowlist of specific endpoints rather than
 * drifting into "anything under /goals" -- `/goals/:id/whatever-comes-later` would not match.
 *
 * Goals are here because retargeting the loop before starting it is the entire point of this
 * mode, and goals are now what the loop is targeted with. Deleting one is deliberately absent:
 * MemoryStore.deleteGoal also clears goal_id across proposals, lessons, notes and runs, and this
 * writer must not be able to reach those tables. Dismissing (status -> retired) is the
 * reversible equivalent and stays within the one table.
 */
export const CONSOLE_ONLY_WRITABLE_ROUTES: RegExp[] = [
  /^\/control\/domains$/,
  /^\/control\/interval$/,
  /^\/control\/pause$/,
  /^\/goals$/,
  /^\/goals\/\d+$/,
  /^\/goals\/\d+\/accept$/,
  /^\/goals\/\d+\/dismiss$/,
];

/** Columns of `goals` this writer may set. Anything else in a patch is ignored, as with the keys above. */
const WRITABLE_GOAL_COLUMNS = new Set(["title", "brief", "status", "weight", "parent_id"]);

export class ControlSettingsWriter {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // The real store creates these too; repeating them here means the writer doesn't depend on
    // load order, and `IF NOT EXISTS` makes it a no-op on every existing DB.
    this.db.exec(`CREATE TABLE IF NOT EXISTS control_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      brief TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      weight REAL NOT NULL DEFAULT 1,
      origin TEXT NOT NULL DEFAULT 'human',
      parent_id INTEGER REFERENCES goals(id),
      rationale TEXT,
      created_at TEXT NOT NULL,
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

  /** Creates a goal. `origin` is fixed to 'human': nothing in this mode runs a model. */
  createGoal(fields: { title: string; brief?: string; weight?: number }): number {
    const at = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO goals (title, brief, status, weight, origin, created_at, updated_at)
         VALUES (?, ?, 'active', ?, 'human', ?, ?)`
      )
      .run(fields.title, fields.brief ?? "", fields.weight ?? 1, at, at);
    return Number(result.lastInsertRowid);
  }

  /**
   * Updates the writable columns of one goal. Column names are taken from a fixed allowlist and
   * never interpolated from caller input, so a patch key that isn't a real column can't become
   * part of the statement.
   */
  updateGoal(id: number, patch: Record<string, unknown>): boolean {
    const entries = Object.entries(patch).filter(
      ([key, value]) => value !== undefined && WRITABLE_GOAL_COLUMNS.has(key)
    );
    if (entries.length === 0) return false;

    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    const values = entries.map(([, value]) => value as string | number | null);
    const result = this.db
      .prepare(`UPDATE goals SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...values, new Date().toISOString(), id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
