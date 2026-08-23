// src/mcp/notes.ts
//
// Research notes: what the agent found out. Market gaps, competitors, pricing, and the
// ground it already ruled out -- roughly a third of the corpus is "I checked, it's
// saturated", which is why `kind` is worth filtering on.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { store } from "./store.js";
import { DEFAULT_LIMIT, FILTER_SCAN, goalArg, kindArg, limitArg } from "./args.js";
import { rendered, renderNote } from "./render.js";
import { lookupGoal, titlesById } from "./goals.js";

export function registerNoteTools(server: McpServer) {
  server.registerTool(
    "research_notes_search",
    {
      title: "Search research notes",
      description:
        "Search the agent's research notes by topic or phrase. Semantic when the agent's vector " +
        "search is configured, substring matching otherwise. Notes are what research found: market " +
        "gaps, competitors, pricing, and dead ends it already ruled out.",
      inputSchema: {
        query: z.string().describe("What to look for."),
        limit: limitArg,
        goal: goalArg,
        kind: kindArg,
      },
    },
    async ({ query, limit, goal, kind }) => {
      const goalId = goal ? lookupGoal(goal).id : undefined;
      const rows = await store.searchResearchNotes(query, limit ?? DEFAULT_LIMIT, { goalId, kind });
      const goals = titlesById();
      return rendered(
        `Research notes matching "${query}"`,
        rows.map((r) => renderNote(r, goals)),
        `No research notes matched "${query}".`
      );
    }
  );

  server.registerTool(
    "research_notes_list",
    {
      title: "List recent research notes",
      description:
        "The agent's most recent research notes, newest first. Use this to browse rather than search.",
      inputSchema: { limit: limitArg, goal: goalArg, kind: kindArg },
    },
    async ({ limit, goal, kind }) => {
      const goalId = goal ? lookupGoal(goal).id : undefined;
      const filtered = goalId != null || kind != null;
      const rows = store
        .listAllResearchNotes(filtered ? FILTER_SCAN : (limit ?? DEFAULT_LIMIT))
        .filter((r) => (goalId == null || r.goal_id === goalId) && (!kind || r.kind === kind))
        .slice(0, limit ?? DEFAULT_LIMIT);
      const goals = titlesById();
      return rendered("Recent research notes", rows.map((r) => renderNote(r, goals)), "No research notes on file.");
    }
  );
}
