// src/mcp/proposals.ts
//
// Proposals: what the agent wants to do, what a human decided about it, and how the
// approved work went. Reading only -- approving or rejecting is the one irreversible human
// act in the loop and it happens in the console, behind a review card that shows the fence
// and the money path together.
//
// `proposals_list` is the queue; `proposal_get` is the whole record for one, which is where
// the monetization block, the step list, the required_tools fence and the act verdict live.
// None of those were reachable from an MCP client before, and they are most of what a
// pending proposal actually says.

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
    // true of every act phase that ran before the column existed -- several of which shipped
    // a repo and a live site -- so it counts as stalled only when the proposal has no
    // act-phase actions at all. Re-deriving that here would eventually drift from it.
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
      title: "List proposals",
      description:
        "The agent's proposals: what it wants to do and what was decided. 'open' is pending plus " +
        "approved, 'pending' is what is waiting on a human decision, and 'stalled' is approved work " +
        "whose build stopped and which nothing will pick up again until someone re-runs it. " +
        "Reading only -- approving and rejecting happen in the web console.",
      inputSchema: {
        status: z.enum(STATUSES).optional().describe("Which proposals to list (default: open)."),
        goal: goalArg,
        query: z.string().optional().describe("Only proposals whose domain or description contains this text."),
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
      return rendered(
        `Proposals (${status ?? "open"})`,
        rows.map((p) => renderProposalSummary(p, goals, p.goal_id)),
        "No proposals matched."
      );
    }
  );

  server.registerTool(
    "proposal_get",
    {
      title: "Read one proposal in full",
      description:
        "Everything on record for one proposal: the full description, the tools the act phase is " +
        "fenced to (with how much damage each can do), the money path it had to state before it " +
        "could be filed, the ordered steps and who owns each, whether the approved work actually " +
        "finished, the recorded outcome, and what the proposal cost in model API spend to produce.",
      inputSchema: { id: z.number().int().positive().describe("The proposal's id, as shown by proposals_list.") },
    },
    async ({ id }) => {
      const row = store.getProposal(id);
      if (!row) return result(`No proposal #${id}.`);

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
        })
      );
    }
  );
}
