// src/mcp/lessons.ts
//
// Lessons: what the agent concluded from real outcomes, with a confidence that moves as
// later outcomes confirm or contradict it.
//
// Muted lessons -- ones a human judged wrong -- are excluded here exactly as they are for
// the agent. Muting is the one curation act that reaches everything at once, because
// searchLessons is the single chokepoint every lesson_search goes through; a lesson taken
// out of the agent's reasoning must not come back through a second door.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { store } from "./store.js";
import { DEFAULT_LIMIT, FILTER_SCAN, goalArg, limitArg } from "./args.js";
import { rendered, renderLesson } from "./render.js";
import { lookupGoal, titlesById } from "./goals.js";

export function registerLessonTools(server: McpServer) {
  server.registerTool(
    "lessons_search",
    {
      title: "Search lessons",
      description:
        "Search the lessons the agent distilled from real outcomes. Muted lessons -- ones a human " +
        "judged wrong -- are excluded, the same way they are for the agent itself. Each lesson " +
        "carries a confidence and how often it has been reinforced or contradicted since.",
      inputSchema: { query: z.string().describe("What to look for."), limit: limitArg },
    },
    async ({ query, limit }) => {
      const rows = await store.searchLessonsByText(query, limit ?? DEFAULT_LIMIT);
      const goals = titlesById();
      return rendered(
        `Lessons matching "${query}"`,
        rows.map((r) => renderLesson(r, goals)),
        `No lessons matched "${query}".`
      );
    }
  );

  server.registerTool(
    "lessons_list",
    {
      title: "List recent lessons",
      description: "The agent's most recently updated lessons, newest first. Muted lessons are excluded.",
      inputSchema: { limit: limitArg, goal: goalArg },
    },
    async ({ limit, goal }) => {
      const goalId = goal ? lookupGoal(goal).id : undefined;
      // listAllLessons is the console's *curation* listing, so it deliberately includes muted
      // rows. This is a reading surface, not a curation one.
      const rows = store
        .listAllLessons(FILTER_SCAN)
        .filter((r) => !r.muted && (goalId == null || r.goal_id === goalId))
        .slice(0, limit ?? DEFAULT_LIMIT);
      const goals = titlesById();
      return rendered("Recent lessons", rows.map((r) => renderLesson(r, goals)), "No lessons on file.");
    }
  );
}
