// src/mcp-server.ts
//
// An MCP server that lets Claude Desktop (or any MCP client) read this agent's record:
// what it was pointed at (goals), what it found out (research notes), what it learned
// (lessons), the ideas it filed and what was decided (proposals), and what its deep dives
// concluded (reports).
//
// Read-only, and read-only twice over: the store is opened with SQLite itself rejecting
// writes, and every tool registered here is a search or a listing. There is deliberately
// nothing that adds, edits, mutes, deletes, approves an idea or accepts a suggested
// goal. Those are human acts performed in the console, and an outside client reaching in
// to perform them would be a second, unaudited path into the record the loop reasons from
// -- the exact thing muting exists to prevent.
//
// It talks to the database directly rather than to src/server.ts's REST API, so it works
// whether or not `npm start` is running and needs no port and no AGENT_API_TOKEN. The cost
// is that it must run on the same machine as the DB file.
//
// This file is wiring only. The tools live in src/mcp/, one module per subject, over a
// shared store handle (src/mcp/store.ts) and a pure rendering layer (src/mcp/render.ts).
// Two load-bearing details moved with them and are documented where they now live:
// src/mcp/store.ts owns the .env-before-qdrant import ordering that decides whether search
// is semantic or LIKE, and src/mcp-env.ts owns the stdout guard, because stdout is the
// protocol channel here and a module can speak while it is still being evaluated.
//
// Search quality comes free: the note and lesson searches take the Qdrant semantic path
// when QDRANT_* is configured in this process's environment and fall back to LIKE matching
// otherwise, exactly as they do for the agent.

import { DB_PATH } from "./mcp/store.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGoalTools } from "./mcp/goals.js";
import { registerNoteTools } from "./mcp/notes.js";
import { registerLessonTools } from "./mcp/lessons.js";
import { registerProposalTools } from "./mcp/proposals.js";
import { registerReportTools } from "./mcp/reports.js";

const server = new McpServer({ name: "reflexloop-memory", version: "1.2.0" });

registerGoalTools(server);
registerNoteTools(server);
registerLessonTools(server);
registerProposalTools(server);
registerReportTools(server);

await server.connect(new StdioServerTransport());
console.error(`[mcp] reflexloop-memory serving ${DB_PATH} (read-only)`);
