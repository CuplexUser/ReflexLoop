// src/mcp/deliverables.ts
//
// What the agent has actually built, and where to click to see it. One record per approved
// proposal that produced something reachable, with every repo, live deployment and PR as a
// real URL -- which is the answer most worth having in a chat client, since it is a list of
// links rather than a table to scroll.
//
// Derived on read by buildDeliverables(), the identical four-call composition the console's
// GET /api/deliverables uses, so this cannot disagree with the action log and adds no state.
// Every artifact comes from a write tool's own result, never from scanning prose for things
// that look like links.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { store } from "./store.js";
import { DEFAULT_LIMIT, limitArg } from "./args.js";
import { rendered, renderDeliverable } from "./render.js";
import { buildDeliverables, type Deliverable, type DeliverableOutcomeRow } from "../deliverables.js";

/**
 * A build that stopped short. `running` is included because an MCP client reads the database,
 * not the live process -- it cannot tell a phase that is running right now from one whose
 * process went away, and reporting the row as it stands is the honest answer.
 */
const unfinished = (d: Deliverable) =>
  d.actStatus === "running" ||
  d.actStatus === "interrupted" ||
  d.actStatus === "incomplete" ||
  d.artifacts.length === 0;

export function registerDeliverableTools(server: McpServer) {
  server.registerTool(
    "deliverables_list",
    {
      title: "List what the agent has built",
      description:
        "Everything the agent has shipped that is reachable: repos, live deployments and pull " +
        "requests, newest activity first, each with its URL. A card is built from whatever write " +
        "tool succeeded, which is not the same as a finished build -- so each one also says " +
        "whether its act phase completed, and an unfinished build is shown rather than hidden.",
      inputSchema: {
        unfinishedOnly: z
          .boolean()
          .optional()
          .describe("Only builds that stopped short or produced no browsable artifact."),
        limit: limitArg,
      },
    },
    async ({ unfinishedOnly, limit }) => {
      const all = buildDeliverables(
        store.listDeliverableActions(),
        store.listAllProposals(),
        store.listOutcomes() as unknown as DeliverableOutcomeRow[],
        store.actActionCounts()
      );
      const rows = (unfinishedOnly ? all.filter(unfinished) : all)
        .slice()
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
        .slice(0, limit ?? DEFAULT_LIMIT);
      return rendered(
        unfinishedOnly ? "Unfinished builds" : "Deliverables",
        rows.map(renderDeliverable),
        unfinishedOnly ? "No unfinished builds." : "Nothing built yet."
      );
    }
  );
}
