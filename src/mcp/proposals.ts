// src/mcp/proposals.ts
//
// Ideas (stored as proposals): what the agent filed, what a human decided about it, and what
// its deep dive concluded. Reading only -- approving or rejecting happens in the console,
// behind a review card that shows the market read and the money path together.
//
// `proposals_list` is the queue; `proposal_get` is the whole record for one, which is where
// the market block, the monetization block, the launch outline and the latest report's verdict
// live. The tool names keep "proposal" because MCP clients may already have them configured.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { store } from "./store.js";
import { DEFAULT_LIMIT, goalArg, limitArg } from "./args.js";
import { rendered, result, renderProposalDetail, renderProposalSummary, type OutcomeLike } from "./render.js";
import { lookupGoal, titlesById } from "./goals.js";
import type { ProposalRow } from "../memory-server.js";

const STATUSES = ["open", "pending", "approved", "rejected", "stalled", "all"] as const;
type StatusArg = (typeof STATUSES)[number];

function select(status: StatusArg): ProposalRow[] {
  switch (status) {
    case "open":
      return store.listOpenProposals();
    // Deliberately the store's own query rather than a filter over listAllProposals: its
    // `act_status IS NULL` rule is load-bearing. Null means "no verdict on record", which is
    // true of every build-mode act phase that ran before the column existed, so it counts as
    // stalled only when the proposal has no act-phase actions at all. Re-deriving that here
    // would eventually drift from it.
    case "stalled":
      return store.listStalledBuilds();
    case "all":
      return store.listAllProposals();
    default:
      return store.listAllProposals().filter((p) => p.status === status);
  }
}

export function registerProposalTools(server: McpServer) {
  server.registerTool(
    "proposals_list",
    {
      title: "List ideas",
      description:
        "The ideas the agent filed and what was decided about each, with its research viability score " +
        "and, once deep-dived, its report verdict. 'open' is pending plus approved, 'pending' is what is " +
        "waiting on a human decision, and 'stalled' is approved ideas whose deep dive stopped without a " +
        "report and which nothing will pick up again until someone re-runs it. " +
        "Reading only -- approving and rejecting happen in the web console.",
      inputSchema: {
        status: z.enum(STATUSES).optional().describe("Which proposals to list (default: open)."),
        goal: goalArg,
        query: z.string().optional().describe("Only ideas whose domain or description contains this text."),
        limit: limitArg,
      },
    },
    async ({ status, goal, query, limit }) => {
      const goalId = goal ? lookupGoal(goal).id : undefined;
      const needle = query?.trim().toLowerCase();
      const rows = select(status ?? "open")
        .filter((p) => goalId == null || p.goal_id === goalId)
        .filter(
          (p) =>
            !needle ||
            p.domain.toLowerCase().includes(needle) ||
            p.description.toLowerCase().includes(needle)
        )
        .slice(0, limit ?? DEFAULT_LIMIT);
      const goals = titlesById();
      const reports = store.latestReportsByProposal();
      return rendered(
        `Ideas (${status ?? "open"})`,
        rows.map((p) => renderProposalSummary(p, goals, p.goal_id, reports.get(p.id))),
        "No ideas matched."
      );
    }
  );

  server.registerTool(
    "proposal_get",
    {
      title: "Read one idea in full",
      description:
        "Everything on record for one idea: its latest deep-dive verdict, the full description, the " +
        "research phase's market read (demand evidence, competitors, size, risks), the money path it had " +
        "to state before it could be filed, the launch outline, and what it cost in model API spend. " +
        "Legacy build-mode proposals also show their tool fence and recorded outcome.",
      inputSchema: { id: z.number().int().positive().describe("The idea's id, as shown by proposals_list.") },
    },
    async ({ id }) => {
      const row = store.getProposal(id);
      if (!row) return result(`No idea #${id}.`);

      const outcome =
        (store.listOutcomes() as unknown as OutcomeLike[]).find((o) => o.proposal_id === id) ?? null;
      const runs = store.listRunsForProposal(id);
      const goalTitle = row.goal_id != null ? (titlesById().get(row.goal_id) ?? null) : null;

      return result(
        renderProposalDetail(row, {
          goalTitle,
          outcome,
          spend: { costUsd: runs.reduce((sum, r) => sum + r.cost_usd, 0), phases: runs.length },
          actCalls: store.actActionCounts().get(id) ?? 0,
          report: store.latestReportsByProposal().get(id) ?? null,
        })
      );
    }
  );
}
