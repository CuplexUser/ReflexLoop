// src/mcp-env.ts
//
// Loading .env for the MCP server, in a module of its own for one reason: ordering.
//
// `qdrant.ts` reads QDRANT_* into module-level consts at load time, and ESM evaluates
// every import before the first statement of the importing file. So a `loadEnv()` call
// sitting at the top of mcp-server.ts's body still runs *after* memory-server.js has
// pulled qdrant.ts in with an empty environment -- semantic search is then silently off
// for the whole process and every search quietly degrades to LIKE matching. Splitting
// this out makes the fix expressible as an import: this module is declared before
// ./memory-server.js, so it is evaluated before it.
//
// The other entry points get away with a plain `import "dotenv/config"` first in the
// list. This one needs a path, because a desktop MCP client launches the server with an
// arbitrary working directory -- so nothing here may resolve against cwd.
//
// It also carries the stdout guard below, for the same reason and with the same
// consequence if it moves. Every module under src/mcp/ imports this one first, so both
// happen before anything else in the process gets a chance to load or to speak.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

// stdout IS the protocol channel on a stdio transport: one stray console.log lands in the
// middle of a JSON-RPC frame and kills the session. memory-server.ts and qdrant.ts carry
// ~20 console.* calls between them, and the import graph now also reaches connectors/load.ts,
// which logs while it is still being *evaluated* -- which is exactly why this repoint lives
// here rather than in mcp-server.ts's body. A statement there runs after every import has
// already been evaluated, so it cannot cover anything a module says on the way in.
// Everything that isn't a protocol message goes to stderr, which MCP clients show as logs.
for (const level of ["log", "info", "debug", "warn"] as const) {
  console[level] = (...args: unknown[]) => console.error(...args);
}

/** The repo root, derived from this file's own location rather than from cwd. */
export const ROOT = fileURLToPath(new URL("../", import.meta.url));

loadEnv({ path: resolve(ROOT, ".env"), quiet: true });

/** Same default as orchestrator.ts, but anchored to ROOT so cwd can't redirect it. */
export const DB_PATH = resolve(ROOT, process.env.AGENT_DB_PATH ?? "./data/agent.db");
