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
import { MemoryStore, buildMemoryServer, type Priority, type ProposalRow } from "./memory-server.js";
import { buildIntegrationsServer, READONLY_INTEGRATION_TOOLS } from "./integrations-server.js";
import { emitAgentEvent } from "./events.js";
import { waitForDecision } from "./review-gateway.js";
import { onReactiveTrigger } from "./reactive-triggers.js";
import { startServer } from "./server.js";

const DOMAINS = (process.env.AGENT_DOMAINS ?? "micro-SaaS tool for developers (self-built and self-hosted),Chrome extension for developers,VS Code extension for developers")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);
const DB_PATH = process.env.AGENT_DB_PATH ?? "./data/agent.db";
const CYCLE_INTERVAL_MS = Number(process.env.AGENT_CYCLE_INTERVAL_MS ?? 1000 * 60 * 60); // 1h default
const SERVER_PORT = Number(process.env.AGENT_SERVER_PORT ?? 4001);
const MAX_PENDING_PROPOSALS = Number(process.env.AGENT_MAX_PENDING_PROPOSALS ?? 5);
// How often the scheduler checks for approved proposals whose next_run_at has
// arrived (scheduled/recurring ones -- immediate approvals skip this and run
// right away, see humanReviewPhase). Default: 15s.
const SCHEDULER_TICK_MS = Number(process.env.AGENT_SCHEDULER_TICK_MS ?? 15_000);

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
  "mcp__memory__action_history_search",
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

// Shared by the periodic research cycle and the reactive (needs_refinement)
// pass below -- same read-only/memory tool grant either way, only the prompt
// differs. Reused as-is so the two can't drift apart on what's allowed.
//
// IMPORTANT: `allowedTools` alone only skips the permission *prompt* for the
// tools named in it -- per the SDK's own docs, restricting which tools are
// actually available requires `canUseTool` (or the `tools` option). Without
// this callback the model had the full default toolset (Bash, Read, Write,
// Edit, ...) available here, permission-bypassed, despite the tool list
// below suggesting otherwise -- confirmed live via a Bash call during a
// research_plan run. Mirrors actPhase's canUseTool pattern instead of
// `permissionMode: "bypassPermissions"`, which is what actually restricts
// this phase to exactly the tools in RESEARCH_ALLOWED_TOOLS.
const RESEARCH_ALLOWED_TOOLS = [
  ...MEMORY_TOOLS,
  "mcp__memory__proposal_create",
  "WebSearch",
  "WebFetch",
  ...READONLY_INTEGRATION_TOOLS,
];
const RESEARCH_OPTIONS: Options = {
  mcpServers,
  allowedTools: RESEARCH_ALLOWED_TOOLS,
  canUseTool: async (toolName) => {
    const allowed = RESEARCH_ALLOWED_TOOLS.includes(toolName);
    return allowed
      ? { behavior: "allow" as const }
      : { behavior: "deny" as const, message: `${toolName} is not available in the research phase` };
  },
  maxTurns: 60,
  // No `agents` option set -> no Agent/Task tool -> this run cannot spawn subagents.
};

async function researchAndPlanPhase(): Promise<ProposalRow[]> {
  const beforeIds = new Set(store.listPendingProposals().map((p) => p.id));

  await runPhase({
    phase: "research_plan",
    proposalId: null,
    prompt: [
      `Domains to research this cycle (pick whichever look most promising -- you don't need to cover all of them evenly): ${DOMAINS.join("; ")}.`,
      `Before anything else, call lesson_search and research_note_search for each domain/topic you're about to look into -- don't re-research what's already known. lesson_search does semantic matching now, so it can surface relevant lessons even when your domain's wording doesn't exactly match a past one.`,
      `Also call action_history_search for each domain -- it shows what's actually been built/deployed/committed on approved proposals so far, so you don't propose duplicate work (e.g. a second repo for something already shipped). Prefer proposing the next step on existing work over starting over.`,
      `You can use the read-only tools github_read_repo, github_read_file, github_search_repos, vercel_list_projects, vercel_get_project, netlify_list_sites, netlify_get_site to check the existing landscape (competing projects, your own prior projects) before proposing.`,
      `Research for concrete, boundable opportunities to earn money. Use WebSearch/WebFetch and the read-only integration tools above. Save distilled findings with research_note_add as you go.`,
      `When you have specific ideas, call proposal_create for each one worth a human's attention -- typically 1, up to 3 per cycle if multiple domains turned up genuinely strong, distinct opportunities. Don't pad the count with weak ideas just to fill a quota.`,
      `Each proposal needs a real cost/time/upside estimate and the exact tool names execution would need. Built-in tools are unprefixed (e.g. 'WebSearch'). MCP tools need their full qualified name -- the act-phase write tools available are: ${WRITE_INTEGRATION_TOOLS.join(", ")}.`,
      `Then stop -- do not act on any proposal, a human reviews each one next.`,
      `If nothing concrete and boundable comes out of the research, don't force a proposal -- just stop.`,
    ].join("\n"),
    options: RESEARCH_OPTIONS,
  });

  return store.listPendingProposals().filter((p) => !beforeIds.has(p.id));
}

// ---- reactive: a human action (marking a proposal "needs refinement") -----
//
// Feeds straight back into research+plan instead of sitting inert -- but
// still only ever produces a *proposal*, gated behind the exact same human
// review as everything else. Guarded against duplicate/overlapping runs for
// the same proposal (in-flight set + a cooldown after each run).

const REACTIVE_COOLDOWN_MS = 60 * 60 * 1000; // 1h
const reactiveInFlight = new Set<number>();
const reactiveLastRunAt = new Map<number, number>();

async function handleReactiveTrigger(proposalId: number): Promise<void> {
  if (reactiveInFlight.has(proposalId)) return;
  const lastRun = reactiveLastRunAt.get(proposalId);
  if (lastRun && Date.now() - lastRun < REACTIVE_COOLDOWN_MS) return;

  const proposal = store.getProposal(proposalId);
  if (!proposal) return;

  reactiveInFlight.add(proposalId);
  try {
    const beforeIds = new Set(store.listPendingProposals().map((p) => p.id));

    await runPhase({
      phase: "research_plan",
      proposalId: proposal.id,
      prompt: [
        `Proposal #${proposal.id} in domain "${proposal.domain}" was marked "needs refinement" by a human reviewer after its deliverable was built: ${proposal.description}`,
        `Call lesson_search and research_note_search for this domain first -- don't re-research what's already known.`,
        `Investigate what's likely missing or broken -- re-read the shipped repo with github_read_repo/github_read_file if that helps.`,
        `If you find something concrete and boundable, call proposal_create for a tightly-scoped follow-up fix addressing the refinement need.`,
        `If there isn't enough signal yet to propose something concrete, save a research_note explaining what's unclear and stop -- don't force a proposal.`,
      ].join("\n"),
      options: RESEARCH_OPTIONS,
    });

    const created = store.listPendingProposals().filter((p) => !beforeIds.has(p.id));
    for (const p of created) enqueueForReview(p);
  } finally {
    reactiveInFlight.delete(proposalId);
    reactiveLastRunAt.set(proposalId, Date.now());
  }
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

  if (decision.approved) {
    // Priority/schedule/recurrence are set by the human right here, at the moment
    // they already approve the proposal -- never by the model, and never editable
    // after the fact except via cancelSchedule.
    store.scheduleApprovedProposal(proposal.id, {
      priority: decision.priority ?? "normal",
      scheduledAt: decision.scheduledAt ?? null,
      recurrenceMs: decision.recurrenceMs ?? null,
    });
  }

  const updated = store.getProposal(proposal.id)!;
  emitAgentEvent({ type: "proposal_decided", proposal: updated });

  if (decision.approved) {
    if (decision.scheduledAt && new Date(decision.scheduledAt).getTime() > Date.now()) {
      emitAgentEvent({ type: "proposal_scheduled", proposal: updated });
    } else {
      // No future schedule -- run right away, same as before this feature existed.
      enqueueDue(updated, false);
    }
  }

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
      // See the comment on RESEARCH_OPTIONS above -- bypassPermissions + allowedTools
      // does not restrict the toolset, only canUseTool does.
      canUseTool: async (toolName) => {
        const allowed = MEMORY_TOOLS.includes(toolName);
        return allowed
          ? { behavior: "allow" as const }
          : { behavior: "deny" as const, message: `${toolName} is not available in the reflect phase` };
      },
      maxTurns: 10,
    },
  });
}

// ---- concurrency: parallel review, priority-ordered serialized act+reflect --
//
// Execution stays fully serialized -- one real side-effecting run at a time,
// same safety property as before -- but which approved proposal goes next now
// respects priority (then earliest due) instead of pure arrival order. A
// proposal lands in runQueue either immediately on approval (humanReviewPhase,
// when it's due right now) or later via the scheduler tick (schedulerTick,
// for anything with a future scheduled_at or a recurring next_run_at).

const PRIORITY_RANK: Record<Priority, number> = { urgent: 3, high: 2, normal: 1, low: 0 };

interface QueuedRun {
  proposal: ProposalRow;
  /** True when this run was woken by the scheduler (a future schedule or a repeat) rather than an immediate approval. */
  wasScheduled: boolean;
}

const runQueue: QueuedRun[] = [];
let workerBusy = false;
let runningProposalId: number | null = null;

function isQueuedOrRunning(id: number): boolean {
  return runningProposalId === id || runQueue.some((r) => r.proposal.id === id);
}

/** Adds a due proposal to the run queue (no-op if it's already queued or running) and kicks the worker. */
function enqueueDue(proposal: ProposalRow, wasScheduled: boolean): void {
  if (isQueuedOrRunning(proposal.id)) return;
  runQueue.push({ proposal, wasScheduled });
  void drainQueue();
}

function pickNext(): QueuedRun | undefined {
  if (runQueue.length === 0) return undefined;
  runQueue.sort((a, b) => {
    const rankDiff = PRIORITY_RANK[b.proposal.priority] - PRIORITY_RANK[a.proposal.priority];
    if (rankDiff !== 0) return rankDiff;
    return (a.proposal.next_run_at ?? "").localeCompare(b.proposal.next_run_at ?? "");
  });
  return runQueue.shift();
}

/** The single worker: runs the best-ranked queued proposal, then recurses to drain anything else already due. */
async function drainQueue(): Promise<void> {
  if (workerBusy) return;
  const next = pickNext();
  if (!next) return;

  workerBusy = true;
  runningProposalId = next.proposal.id;
  try {
    if (next.wasScheduled) {
      emitAgentEvent({ type: "scheduled_run_starting", proposal: next.proposal });
    }
    await actPhase(next.proposal);
    await reflectPhase(next.proposal);
  } catch (err) {
    console.error(`[act] proposal #${next.proposal.id} failed:`, err);
  } finally {
    store.advanceOrClearSchedule(next.proposal.id, {
      recurring: Boolean(next.proposal.recurrence_ms),
      recurrenceMs: next.proposal.recurrence_ms,
    });
    workerBusy = false;
    runningProposalId = null;
  }
  void drainQueue();
}

/** Checks for approved proposals whose next_run_at has arrived and queues them -- the wake-up for scheduled/recurring work. */
function schedulerTick(): void {
  for (const p of store.listDueProposals(new Date().toISOString())) {
    enqueueDue(p, true);
  }
}

/** Fire-and-forget: waits for this proposal's review independently of any others in flight. */
function enqueueForReview(proposal: ProposalRow): void {
  void (async () => {
    const decided = await humanReviewPhase(proposal);
    if (decided.status !== "approved") {
      console.log(`Proposal #${decided.id} rejected. Reason: ${decided.human_notes ?? "(none given)"}`);
    }
  })();
}

// ---- main loop --------------------------------------------------------------

async function mainLoop() {
  console.log(`Agent runner started. Domains: ${DOMAINS.join("; ")}. DB: ${DB_PATH}`);
  startServer(store, DOMAINS, SERVER_PORT);
  onReactiveTrigger((t) => void handleReactiveTrigger(t.proposalId));
  emitAgentEvent({ type: "run_started", domains: DOMAINS });

  // Pick up any proposals left pending from a previous run -- all queued for
  // review in parallel, not one at a time.
  for (const leftover of store.listPendingProposals()) {
    enqueueForReview(leftover);
  }

  // Catch up on anything already due (scheduled/recurring proposals whose time
  // arrived while the process was down), then keep checking on an interval.
  schedulerTick();
  setInterval(schedulerTick, SCHEDULER_TICK_MS);

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
