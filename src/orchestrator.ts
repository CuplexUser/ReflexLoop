// src/orchestrator.ts
//
// Drives agents through: RESEARCH+PLAN -> HUMAN REVIEW -> ACT -> OUTCOME+REFLECT.
// No subagents anywhere -- the 'agents' option is simply never set, so the
// model has no Agent/Task tool available to spawn one.
//
// Concurrency model: research runs one cycle at a time (on CYCLE_INTERVAL_MS),
// and can produce more than one proposal per cycle across AGENT_DOMAINS.
// Every new proposal immediately starts waiting for review in parallel with
// any others already pending -- a human can triage several at once. Once
// approved, a proposal's act+reflect phases are serialized through a single
// queue (scheduleActAndReflect) so real-world side-effecting tool calls
// never run concurrently with each other, even if several proposals are
// approved back to back.
//
// Run with: npx tsx src/orchestrator.ts

import "dotenv/config";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { MemoryStore, buildMemoryServer, type ProposalRow } from "./memory-server.js";
import { buildIntegrationsServer, READONLY_INTEGRATION_TOOLS } from "./integrations-server.js";
import { emitAgentEvent } from "./events.js";
import { waitForDecision } from "./review-gateway.js";
import { startServer } from "./server.js";

const DOMAINS = (process.env.AGENT_DOMAINS ?? "micro-SaaS tool for developers (self-built and self-hosted),Chrome extension for developers,VS Code extension for developers")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);
const DB_PATH = process.env.AGENT_DB_PATH ?? "./data/agent.db";
const CYCLE_INTERVAL_MS = Number(process.env.AGENT_CYCLE_INTERVAL_MS ?? 1000 * 60 * 60); // 1h default
const SERVER_PORT = Number(process.env.AGENT_SERVER_PORT ?? 4001);
const MAX_PENDING_PROPOSALS = Number(process.env.AGENT_MAX_PENDING_PROPOSALS ?? 5);

const store = new MemoryStore(DB_PATH);
const memoryServer = buildMemoryServer(store);
const integrationsServer = buildIntegrationsServer();
const mcpServers = { memory: memoryServer, integrations: integrationsServer };

// Tools always available to the model, in every phase, regardless of what
// the phase is trying to accomplish.
const MEMORY_TOOLS = [
  "mcp__memory__research_note_add",
  "mcp__memory__research_note_search",
  "mcp__memory__lesson_search",
  "mcp__memory__lesson_add",
  "mcp__memory__lesson_reinforce",
  "mcp__memory__proposal_status",
  "mcp__memory__outcome_record",
];

// Act-phase-only integration tools a proposal can request by exact
// (fully-qualified) name -- listed in the research prompt so the model
// doesn't have to guess the mcp__integrations__ prefix.
const WRITE_INTEGRATION_TOOLS = [
  "mcp__integrations__github_create_repo",
  "mcp__integrations__github_create_branch",
  "mcp__integrations__github_commit_file",
  "mcp__integrations__github_create_pr",
  "mcp__integrations__vercel_deploy",
  "mcp__integrations__netlify_create_site",
  "mcp__integrations__netlify_deploy",
];

function preview(value: unknown, max = 150): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  const oneLine = (s ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/** Runs a query to completion, logging every tool call and the run's Claude API cost. */
async function runPhase(opts: {
  phase: "research_plan" | "act" | "reflect";
  prompt: string;
  options: Options;
  proposalId: number | null;
}): Promise<{ finalText: string; costUsd: number }> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let finalText = "";
  let costUsd = 0;

  emitAgentEvent({ type: "phase_start", phase: opts.phase, proposalId: opts.proposalId });

  const hooks: Options["hooks"] = {
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === "PostToolUse") {
              store.logAction(opts.proposalId, opts.phase, input.tool_name, input.tool_input, input.tool_response);
              console.log(`[${opts.phase}] tool: ${input.tool_name} ${preview(input.tool_input)}`);
              emitAgentEvent({
                type: "tool_call",
                phase: opts.phase,
                proposalId: opts.proposalId,
                toolName: input.tool_name,
                input: input.tool_input,
              });
            }
            return { continue: true };
          },
        ],
      },
    ],
  };

  const result = query({
    prompt: opts.prompt,
    options: {
      ...opts.options,
      hooks: { ...(opts.options.hooks ?? {}), ...hooks },
    },
  });

  for await (const message of result as AsyncGenerator<SDKMessage>) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          console.log(`[${opts.phase}] model: ${preview(block.text, 300)}`);
          emitAgentEvent({ type: "model_text", phase: opts.phase, proposalId: opts.proposalId, text: block.text });
        }
      }
    } else if (message.type === "result") {
      costUsd = message.total_cost_usd;
      if (message.subtype === "success") finalText = message.result;
    }
  }

  console.log(`[${opts.phase}] done in ${((Date.now() - t0) / 1000).toFixed(1)}s, cost $${costUsd.toFixed(4)}`);
  store.logRun(opts.proposalId, opts.phase, costUsd, Date.now() - t0, startedAt);
  emitAgentEvent({ type: "phase_done", phase: opts.phase, proposalId: opts.proposalId, costUsd, durationMs: Date.now() - t0 });
  return { finalText, costUsd };
}

// ---- phase 1: research + plan -------------------------------------------
//
// Returns every proposal newly created this cycle (0 to a few) -- research
// can favor whichever domain looks most promising rather than being forced
// to propose evenly across AGENT_DOMAINS, and can surface more than one
// idea per cycle when several are genuinely strong.

async function researchAndPlanPhase(): Promise<ProposalRow[]> {
  const beforeIds = new Set(store.listPendingProposals().map((p) => p.id));

  await runPhase({
    phase: "research_plan",
    proposalId: null,
    prompt: [
      `Domains to research this cycle (pick whichever look most promising -- you don't need to cover all of them evenly): ${DOMAINS.join("; ")}.`,
      `Before anything else, call lesson_search and research_note_search for each domain/topic you're about to look into -- don't re-research what's already known. lesson_search does semantic matching now, so it can surface relevant lessons even when your domain's wording doesn't exactly match a past one.`,
      `You can use the read-only tools github_read_repo, github_read_file, github_search_repos, vercel_list_projects, vercel_get_project, netlify_list_sites, netlify_get_site to check the existing landscape (competing projects, your own prior projects) before proposing.`,
      `Research for concrete, boundable opportunities to earn money. Use WebSearch/WebFetch and the read-only integration tools above. Save distilled findings with research_note_add as you go.`,
      `When you have specific ideas, call proposal_create for each one worth a human's attention -- typically 1, up to 3 per cycle if multiple domains turned up genuinely strong, distinct opportunities. Don't pad the count with weak ideas just to fill a quota.`,
      `Each proposal needs a real cost/time/upside estimate and the exact tool names execution would need. Built-in tools are unprefixed (e.g. 'WebSearch'). MCP tools need their full qualified name -- the act-phase write tools available are: ${WRITE_INTEGRATION_TOOLS.join(", ")}.`,
      `Then stop -- do not act on any proposal, a human reviews each one next.`,
      `If nothing concrete and boundable comes out of the research, don't force a proposal -- just stop.`,
    ].join("\n"),
    options: {
      mcpServers,
      allowedTools: [...MEMORY_TOOLS, "mcp__memory__proposal_create", "WebSearch", "WebFetch", ...READONLY_INTEGRATION_TOOLS],
      permissionMode: "bypassPermissions", // safe: every tool here is read-only or writes to our own memory DB
      maxTurns: 60,
      // No `agents` option set -> no Agent/Task tool -> this run cannot spawn subagents.
    },
  });

  return store.listPendingProposals().filter((p) => !beforeIds.has(p.id));
}

// ---- phase 2: human review -------------------------------------------------
//
// Delivery is the web UI: emits a proposal_pending event (server.ts pushes it
// over WebSocket) and blocks on waitForDecision(), which resolves when a
// person clicks Approve/Reject and the API calls submitDecision(). Whatever
// answers that promise decides; this function just waits and then calls
// store.decideProposal(). Console output is kept too, for anything tailing
// stdout headlessly. Safe to run for several proposals at once -- each
// waits on its own decision promise independently.

async function humanReviewPhase(proposal: ProposalRow): Promise<ProposalRow> {
  console.log("\n=== Proposal awaiting review ===");
  console.log(`#${proposal.id} [${proposal.domain}]`);
  console.log(proposal.description);
  console.log(
    `Expected: cost ${proposal.expected_cost}, time ${proposal.expected_time_hours}h, upside ${proposal.expected_upside}`
  );
  console.log(`Tools required: ${proposal.required_tools}`);

  emitAgentEvent({ type: "proposal_pending", proposal });
  const decision = await waitForDecision(proposal.id);

  store.decideProposal(proposal.id, decision.approved ? "approved" : "rejected", decision.notes);
  const updated = store.getProposal(proposal.id)!;
  emitAgentEvent({ type: "proposal_decided", proposal: updated });
  return updated;
}

// ---- phase 3: act -----------------------------------------------------------
//
// Tool access is hard-limited to exactly what the proposal declared, plus
// memory tools. canUseTool is a second, independent gate on top of
// allowedTools -- belt and suspenders, since allowedTools alone relies on
// the model never being told about a broader tool in the first place.

async function actPhase(proposal: ProposalRow): Promise<void> {
  const requiredTools = proposal.required_tools.split(",").map((s) => s.trim()).filter(Boolean);

  await runPhase({
    phase: "act",
    proposalId: proposal.id,
    prompt: [
      `Execute approved proposal #${proposal.id}: ${proposal.description}`,
      `You may only use these tools: ${requiredTools.join(", ")}, plus memory tools for logging/recall.`,
      `When finished, call outcome_record with the real numbers -- do not estimate, report what actually happened.`,
    ].join("\n"),
    options: {
      mcpServers,
      allowedTools: [...MEMORY_TOOLS, ...requiredTools],
      canUseTool: async (toolName) => {
        const allowed = MEMORY_TOOLS.includes(toolName) || requiredTools.includes(toolName);
        return allowed
          ? { behavior: "allow" as const }
          : { behavior: "deny" as const, message: `${toolName} was not part of the approved proposal` };
      },
      maxTurns: 60,
    },
  });
}

// ---- phase 4: reflect ---------------------------------------------------

async function reflectPhase(proposal: ProposalRow): Promise<void> {
  await runPhase({
    phase: "reflect",
    proposalId: proposal.id,
    prompt: [
      `Proposal #${proposal.id} in domain "${proposal.domain}" has an outcome recorded now.`,
      `Call lesson_search for this domain first. If an existing lesson was confirmed or contradicted by this outcome, call lesson_reinforce on it instead of duplicating it.`,
      `Otherwise, call lesson_add exactly once with a generalized, reusable takeaway -- not a play-by-play retelling of what happened this one time.`,
    ].join("\n"),
    options: {
      mcpServers: { memory: memoryServer },
      allowedTools: [...MEMORY_TOOLS],
      permissionMode: "bypassPermissions",
      maxTurns: 10,
    },
  });
}

// ---- concurrency: parallel review, serialized act+reflect -------------------

let actChainTail: Promise<void> = Promise.resolve();

/** Runs act+reflect for one proposal after whatever's already queued finishes -- never concurrently with another. */
function scheduleActAndReflect(proposal: ProposalRow): Promise<void> {
  const run = actChainTail
    .then(() => actPhase(proposal))
    .then(() => reflectPhase(proposal))
    .catch((err) => {
      console.error(`[act] proposal #${proposal.id} failed:`, err);
    });
  actChainTail = run;
  return run;
}

/** Fire-and-forget: waits for this proposal's review independently of any others in flight. */
function enqueueForReview(proposal: ProposalRow): void {
  void (async () => {
    const decided = await humanReviewPhase(proposal);
    if (decided.status !== "approved") {
      console.log(`Proposal #${decided.id} rejected. Reason: ${decided.human_notes ?? "(none given)"}`);
      return;
    }
    await scheduleActAndReflect(decided);
  })();
}

// ---- main loop --------------------------------------------------------------

async function mainLoop() {
  console.log(`Agent runner started. Domains: ${DOMAINS.join("; ")}. DB: ${DB_PATH}`);
  startServer(store, DOMAINS, SERVER_PORT);
  emitAgentEvent({ type: "run_started", domains: DOMAINS });

  // Pick up any proposals left pending from a previous run -- all queued for
  // review in parallel, not one at a time.
  for (const leftover of store.listPendingProposals()) {
    enqueueForReview(leftover);
  }

  while (true) {
    const pendingCount = store.listPendingProposals().length;
    if (pendingCount >= MAX_PENDING_PROPOSALS) {
      console.log(`${pendingCount} proposals already pending review (max ${MAX_PENDING_PROPOSALS}); skipping research this cycle.`);
    } else {
      const proposals = await researchAndPlanPhase();
      if (proposals.length > 0) {
        for (const p of proposals) enqueueForReview(p);
      } else {
        console.log("No proposal this cycle.");
      }
    }
    const nextCycleAt = new Date(Date.now() + CYCLE_INTERVAL_MS).toISOString();
    emitAgentEvent({ type: "cycle_idle", nextCycleAt });
    await sleep(CYCLE_INTERVAL_MS);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

mainLoop().catch((err) => {
  console.error(err);
  store.close();
  process.exit(1);
});
