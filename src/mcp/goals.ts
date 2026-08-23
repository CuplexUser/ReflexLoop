// src/mcp/goals.ts
//
// Goals are what the loop is pointed at, and the thing the operator curates. Reading them
// used to be possible here only as a side effect of getting a `goal` argument wrong --
// resolveGoal answers a miss with the list of titles that exist. That was the right trade
// when a goal was an id lookup and nothing else; it stopped being one when goals grew a
// brief, a weight, per-lane health, and a `suggested` queue the agent writes to.
//
// Reading them is all this does. `goal_suggest` lets the agent propose a lane and nothing
// more: a suggested goal is excluded from activeGoals(), never reaches a prompt, and
// resolveGoalId refuses to file anything under it. Only a human clicking Accept in the
// console makes it real, and nothing here shortens that path -- for the same reason nothing
// here approves a proposal.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { store } from "./store.js";
import { limitArg, MAX_LIMIT } from "./args.js";
import { rendered, renderGoal, resolveGoal, goalTitles } from "./render.js";
import type { GoalRow, GoalStatus } from "../memory-server.js";

/** Every tool that scopes to a goal resolves the title through the same lookup. */
export const lookupGoal = (name: string): GoalRow => resolveGoal(store.listGoals(), name);

/** id → title, for rendering the goal a note/lesson/proposal was filed under. */
export const titlesById = () => goalTitles(store.listGoals());

export function registerGoalTools(server: McpServer) {
  server.registerTool(
    "goals_list",
    {
      title: "List goals",
      description:
        "The lanes the agent researches, with how each one is doing. A goal has a short title " +
        "(the stable key everything is filed under) and a brief (the research instructions the " +
        "model is handed verbatim). Status 'suggested' means the agent proposed the lane and it " +
        "is inert until a human accepts it in the console; 'retired' means it was closed on " +
        "purpose and will not come back.",
      inputSchema: {
        status: z
          .enum(["active", "paused", "suggested", "retired", "all"])
          .optional()
          .describe("Restrict to one status (default: all)."),
        limit: limitArg,
      },
    },
    async ({ status, limit }) => {
      const goals = status && status !== "all" ? store.listGoals(status as GoalStatus) : store.listGoals();
      // Health is one grouped query over every goal, so it's cheaper to fetch whole and index
      // than to filter -- and it keys on goal_id, matching what listGoals returns.
      const health = new Map(store.goalHealth().map((h) => [h.goal_id, h]));
      // Goals are a small curated set; showing all of them is the useful default, unlike the
      // note and lesson listings where 10 is a sane page.
      const rows = goals.slice(0, limit ?? MAX_LIMIT);
      return rendered(
        status && status !== "all" ? `Goals (${status})` : "Goals",
        rows.map((g) => renderGoal(g, health.get(g.id))),
        status && status !== "all" ? `No ${status} goals.` : "No goals configured."
      );
    }
  );
}
