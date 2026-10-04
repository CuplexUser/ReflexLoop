// src/mcp/reports.ts
//
// Deep-dive reports: the agent's written verdict on each idea a human approved for a closer
// look. The answer most worth having in a chat client, since it is the conclusion rather than
// the trail that led to it. Reading only, like everything in this server.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { store } from "./store.js";
import { DEFAULT_LIMIT, goalArg, limitArg } from "./args.js";
import { rendered, renderReport, renderReportSummary, result } from "./render.js";
import { lookupGoal, titlesById } from "./goals.js";
import { REPORT_VERDICTS } from "../memory-server.js";

export function registerReportTools(server: McpServer) {
  server.registerTool(
    "reports_list",
    {
      title: "List deep-dive reports",
      description:
        "Feasibility reports, newest first: each one's verdict (pursue / maybe / drop), viability score, " +
        "confidence and summary. A report is what a deep dive produces once a human approved an idea for " +
        "a closer look. Use report_get for the full text and sources.",
      inputSchema: {
        verdict: z.enum(REPORT_VERDICTS).optional().describe("Only reports with this verdict."),
        goal: goalArg,
        limit: limitArg,
      },
    },
    async ({ verdict, goal, limit }) => {
      const goalId = goal ? lookupGoal(goal).id : undefined;
      const rows = store.listReports({ goalId, verdict, limit: limit ?? DEFAULT_LIMIT });
      return rendered(
        verdict ? `Reports (${verdict})` : "Reports",
        rows.map(renderReportSummary),
        "No reports matched."
      );
    }
  );

  server.registerTool(
    "report_get",
    {
      title: "Read one report in full",
      description:
        "One deep-dive report in full: verdict, summary, the whole Markdown body and every source. " +
        "Pass the report's id, or an idea's id to get that idea's latest report.",
      inputSchema: {
        id: z.number().int().positive().optional().describe("The report's id, as shown by reports_list."),
        proposalId: z.number().int().positive().optional().describe("An idea's id; returns its latest report."),
      },
    },
    async ({ id, proposalId }) => {
      if ((id === undefined) === (proposalId === undefined)) return result("Pass exactly one of `id` or `proposalId`.");
      const row = id !== undefined ? store.getReport(id) : store.listReportsForProposal(proposalId!)[0];
      if (!row) return result(id !== undefined ? `No report #${id}.` : `Idea #${proposalId} has no report yet.`);
      const idea = store.getProposal(row.proposal_id);
      const headline = idea?.description.split("\n").find((l) => l.trim()) ?? null;
      const goalTitle = row.goal_id != null ? (titlesById().get(row.goal_id) ?? null) : null;
      return result(renderReport(row, { ideaHeadline: headline, goalTitle }));
    }
  );
}
