// src/mcp/store.ts
//
// The one open handle on the agent's database, shared by every tool module.
//
// Read-only twice over, exactly as console-only mode opens it: SQLite itself rejects
// writes, and nothing registered on this server calls a write method anyway. Curating
// this record is a human act performed in the console -- an outside client reaching in
// to add, edit, mute or delete would be a second, unaudited path into the memory the
// loop reasons from.
//
// KEEP THE ../mcp-env.js IMPORT FIRST, here and in every sibling module. It loads .env and
// repoints stdout, and qdrant.ts (reached through memory-server.js) reads QDRANT_* at module
// load -- so a module that pulls memory-server.js in ahead of it turns semantic search off for
// the whole process, silently, with every search quietly degrading to LIKE matching. Owning
// the store here rather than in mcp-server.ts is what makes that rule structural instead of a
// property of one file's import order: whichever tool module the bundler evaluates first, it
// reaches memory-server.js through this one.

import "../mcp-env.js";
import { DB_PATH } from "../mcp-env.js";
import { MemoryStore } from "../memory-server.js";

function open(): MemoryStore {
  try {
    return new MemoryStore(DB_PATH, { readOnly: true });
  } catch (err) {
    console.error(`[mcp] cannot open ${DB_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export const store = open();
export { DB_PATH };
