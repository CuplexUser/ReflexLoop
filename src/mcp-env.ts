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

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

/** The repo root, derived from this file's own location rather than from cwd. */
export const ROOT = fileURLToPath(new URL("../", import.meta.url));

loadEnv({ path: resolve(ROOT, ".env"), quiet: true });

/** Same default as orchestrator.ts, but anchored to ROOT so cwd can't redirect it. */
export const DB_PATH = resolve(ROOT, process.env.AGENT_DB_PATH ?? "./data/agent.db");
