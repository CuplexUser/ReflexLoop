// src/orchestrator.ts
//
// Drives agents through: RESEARCH+PLAN -> HUMAN REVIEW -> ACT -> OUTCOME+REFLECT.
// No subagents anywhere -- the tool registry has no tool that spawns one, and the
// loop in agent-loop.ts only ever dispatches tools from that registry.
//
// The model behind this is whatever AGENT_PROVIDER/AGENT_MODEL name (OpenRouter,
// OpenAI, Anthropic, xAI or Moonshot); nothing in this file is provider-specific.
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
import { runAgent } from "./agent-loop.js";
import { describeClients, resolveLlmClients } from "./llm/index.js";
import { getSearchConfig } from "./search/index.js";
import { ToolRegistry } from "./tools/registry.js";
import { buildWebTools } from "./tools/web.js";
import { MemoryStore, buildMemoryTools, type Priority, type ProposalRow } from "./memory-server.js";
import { buildIntegrationsTools } from "./integrations-server.js";
import {
  MEMORY_TOOLS,
  READONLY_BUILTIN_TOOLS,
  READONLY_INTEGRATION_TOOLS,
  WRITE_INTEGRATION_TOOLS,
} from "./tool-catalog.js";
import { emitAgentEvent } from "./events.js";
import { waitForDecision } from "./review-gateway.js";
import { onReactiveTrigger } from "./reactive-triggers.js";
import {
  consumeDirective,
  getControlState,
  initControl,
  onAbort,
  onRunNow,
  reportExecutionState,
} from "./agent-control.js";
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

/**
 * Config problems (no AGENT_MODEL, an unknown provider, a search mode whose key is
 * missing) are all a person's .env being wrong, not a bug -- so they get a readable
 * line and a clean exit rather than a stack trace from module-load depth.
 */
function loadConfigOrExit<T>(load: () => T): T {
  try {
    return load();
  } catch (err) {
    console.error(`\nConfiguration error: ${err instanceof Error ? err.message : String(err)}`);
    console.error("Copy .env.example to .env and fill it in, then try again.\n");
    process.exit(1);
  }
}

// One client per phase. They're usually the same model, but they don't have to be:
// research is wide and cheap to get wrong, act writes real code into real repos with
// no build step to catch mistakes, and reflect is two short memory calls. See the
// AGENT_*_PROVIDER / AGENT_*_MODEL overrides in llm/index.ts.
const llmByPhase = loadConfigOrExit(resolveLlmClients);

// One registry for the whole process; each phase gets a subset by name, never a
// different registry. buildWebTools() contributes WebFetch always and WebSearch only
// when an HTTP search provider is configured -- in native mode the provider searches
// server-side instead, and agent-loop.ts handles that from the same "WebSearch" grant.
const registry = loadConfigOrExit(
  () => new ToolRegistry([...buildMemoryTools(store), ...buildIntegrationsTools(), ...buildWebTools()])
);

// MEMORY_TOOLS (always available, every phase) and WRITE_INTEGRATION_TOOLS
// (act-phase-only, and only when an approved proposal names them) both live in
// tool-catalog.ts now -- server.ts validates operator edits to a proposal's
// required_tools against the same lists, and they can't be allowed to drift.

/**
 * Shared framing for every phase. The Agent SDK supplied a system prompt of its own
 * (a coding-agent persona with filesystem tools); this loop has no such default, so
 * the operating rules that used to be implicit are stated here once instead of being
 * repeated in each phase prompt.
 */
const BASE_SYSTEM = [
  "You are an autonomous agent that researches money-making opportunities, proposes concrete plans, and -- only after a human approves -- executes them and records what actually happened.",
  "You work entirely through the tools you are given. You have no filesystem, no shell, and no ability to run code: if a tool doesn't exist for something, you cannot do it, and you should say so rather than pretending otherwise.",
  "Only the tools listed for the current phase are available. Do not invent tool names or describe a tool call in prose instead of calling it.",
  "Be concrete and honest. Estimates are estimates and must be labelled as such; recorded outcomes must be what actually happened, including failures.",
].join("\n");

function preview(value: unknown, max = 150): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  const oneLine = (s ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/**
 * Runs one phase to completion, logging every tool call and the phase's API spend.
 *
 * Spend is no longer handed to us the way the SDK's `total_cost_usd` was -- it's
 * computed from token usage, or taken from the provider when it reports a real
 * per-call charge (OpenRouter does). See llm/pricing.ts.
 */
async function runPhase(opts: {
  phase: "research_plan" | "act" | "reflect";
  prompt: string;
  system: string;
  allowedTools: string[];
  maxTurns: number;
  proposalId: number | null;
  signal?: AbortSignal;
}): Promise<{ finalText: string; costUsd: number }> {
  // An aborted run still gets its cost and duration logged below -- spend already
  // incurred counts against profit whether or not the phase finished.
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let finalText = "";
  let costUsd = 0;

  emitAgentEvent({ type: "phase_start", phase: opts.phase, proposalId: opts.proposalId });

  try {
    const result = await runAgent({
      client: llmByPhase[opts.phase],
      registry,
      system: opts.system,
      prompt: opts.prompt,
      allowedTools: opts.allowedTools,
      maxTurns: opts.maxTurns,
      signal: opts.signal,
      // Accumulated per turn rather than read off the result, so an abort or a crash
      // mid-phase still records what was already spent.
      onTurnCost: (usd) => {
        costUsd += usd;
      },
      onAssistantText: (text) => {
        console.log(`[${opts.phase}] model: ${preview(text, 300)}`);
        emitAgentEvent({ type: "model_text", phase: opts.phase, proposalId: opts.proposalId, text });
      },
      onToolCall: (toolName, input, output) => {
        store.logAction(opts.proposalId, opts.phase, toolName, input, output);
        console.log(`[${opts.phase}] tool: ${toolName} ${preview(input)}`);
        emitAgentEvent({ type: "tool_call", phase: opts.phase, proposalId: opts.proposalId, toolName, input });
      },
    });
    finalText = result.finalText;
    if (result.stopReason === "max_turns") {
      console.warn(`[${opts.phase}] hit the ${opts.maxTurns}-turn limit; stopping with whatever it had done so far.`);
    }
  } finally {
    // In the finally so an aborted or failed phase is still accounted for: the spend
    // and the tool calls that already happened are real either way, and a phase that
    // vanished from the ledger because it crashed would understate what the loop cost.
    console.log(`[${opts.phase}] done in ${((Date.now() - t0) / 1000).toFixed(1)}s, cost $${costUsd.toFixed(4)}`);
    const client = llmByPhase[opts.phase];
    store.logRun(opts.proposalId, opts.phase, costUsd, Date.now() - t0, startedAt, client.provider, client.model);
    emitAgentEvent({
      type: "phase_done",
      phase: opts.phase,
      proposalId: opts.proposalId,
      costUsd,
      durationMs: Date.now() - t0,
    });
  }

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
// Everything here is read-only or writes only to the agent's own memory DB, which
// is why this phase can be granted its whole list up front with no human in the
// loop. WebSearch is listed whether or not a local WebSearch tool exists -- in
// native mode agent-loop.ts reads this grant and turns on the provider's own
// server-side search instead. Nothing outside this list is described to the model
// or dispatchable by it; see the fence note in agent-loop.ts.
const RESEARCH_ALLOWED_TOOLS = [
  ...MEMORY_TOOLS,
  "mcp__memory__proposal_create",
  ...READONLY_BUILTIN_TOOLS,
  ...READONLY_INTEGRATION_TOOLS,
];

const RESEARCH_SYSTEM = [
  BASE_SYSTEM,
  "You are in the RESEARCH+PLAN phase. Nothing you do here touches the real world: you can read the web, read existing repos and deployments, and write to your own memory. That is all.",
  "Your only output that matters is proposals. You cannot execute anything in this phase, and a proposal you create will sit until a human approves it.",
].join("\n");

const RESEARCH_MAX_TURNS = 60;

async function researchAndPlanPhase(): Promise<ProposalRow[]> {
  const beforeIds = new Set(store.listPendingProposals().map((p) => p.id));
  const domains = getControlState().domains;
  // A directive steers exactly one cycle, then clears itself -- it's a nudge for this
  // run, not a standing instruction that quietly reshapes every future cycle. It can
  // only redirect what gets researched; the output is still a proposal needing approval.
  const directive = consumeDirective();

  await runPhase({
    phase: "research_plan",
    proposalId: null,
    prompt: [
      `Domains to research this cycle (pick whichever look most promising -- you don't need to cover all of them evenly): ${domains.join("; ")}.`,
      ...(directive ? [`The operator left a directive for this cycle -- weight it heavily: ${directive}`] : []),
      `Before anything else, call lesson_search and research_note_search for each domain/topic you're about to look into -- don't re-research what's already known. lesson_search does semantic matching now, so it can surface relevant lessons even when your domain's wording doesn't exactly match a past one.`,
      `Also call action_history_search for each domain -- it shows what's actually been built/deployed/committed on approved proposals so far, so you don't propose duplicate work (e.g. a second repo for something already shipped). Prefer proposing the next step on existing work over starting over.`,
      `You can use the read-only tools github_read_repo, github_read_file, github_search_repos, vercel_list_projects, vercel_get_project, netlify_list_sites, netlify_get_site to check the existing landscape (competing projects, your own prior projects) before proposing.`,
      `Research for concrete, boundable opportunities to earn money. Use WebSearch/WebFetch and the read-only integration tools above. Save distilled findings with research_note_add as you go.`,
      `When you have specific ideas, call proposal_create for each one worth a human's attention -- typically 1, up to 3 per cycle if multiple domains turned up genuinely strong, distinct opportunities. Don't pad the count with weak ideas just to fill a quota.`,
      `Each proposal needs a real cost/time/upside estimate and the exact tool names execution would need. Built-in tools are unprefixed (e.g. 'WebSearch'). MCP tools need their full qualified name -- the act-phase write tools available are: ${WRITE_INTEGRATION_TOOLS.join(", ")}. For GitHub work: prefer github_commit_files (one commit, many files) over repeated github_commit_file calls; and either commit straight to the default branch, or if you use github_create_pr, list github_merge_pr in required_tools too and merge it during the act phase -- an approved proposal has no further GitHub-side review to wait for, so an unmerged PR just leaves the default branch empty.`,
      `Then stop -- do not act on any proposal, a human reviews each one next.`,
      `If nothing concrete and boundable comes out of the research, don't force a proposal -- just stop.`,
    ].join("\n"),
    system: RESEARCH_SYSTEM,
    allowedTools: RESEARCH_ALLOWED_TOOLS,
    maxTurns: RESEARCH_MAX_TURNS,
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
      system: RESEARCH_SYSTEM,
      allowedTools: RESEARCH_ALLOWED_TOOLS,
      maxTurns: RESEARCH_MAX_TURNS,
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

const REFLECT_SYSTEM = [
  BASE_SYSTEM,
  "You are in the REFLECT phase. You can only read and write your own memory -- no web access, no integrations, nothing that touches the outside world.",
  "Write lessons that will still be useful to a future cycle looking at a different opportunity in the same domain. A retelling of this one event is not a lesson.",
].join("\n");

const REFLECT_MAX_TURNS = 10;

/**
 * A rejection is a signal too -- without this the agent learns nothing from being told no,
 * and the next cycle is free to re-propose the same idea. Runs the same memory-only reflect
 * grant as a post-outcome reflection; there is no outcome row here, just the human's reason.
 */
async function reflectOnRejectionPhase(proposal: ProposalRow): Promise<void> {
  await runPhase({
    phase: "reflect",
    proposalId: proposal.id,
    prompt: [
      `Proposal #${proposal.id} in domain "${proposal.domain}" was REJECTED by the human reviewer: ${proposal.description}`,
      `Their stated reason: ${proposal.human_notes?.trim() || "(none given)"}`,
      `Call lesson_search for this domain first. If an existing lesson already covers why this kind of proposal gets rejected, call lesson_reinforce on it rather than duplicating it.`,
      `Otherwise call lesson_add exactly once with a generalized takeaway about what makes a proposal in this domain not worth approving -- something that would stop you re-proposing this same idea next cycle. Don't record the rejection as a play-by-play.`,
      `If no reason was given, infer nothing beyond the obvious and keep the lesson conservative -- a low-confidence, narrowly-worded note is better than a confident guess about why.`,
    ].join("\n"),
    system: REFLECT_SYSTEM,
    allowedTools: [...MEMORY_TOOLS],
    maxTurns: REFLECT_MAX_TURNS,
  });
}

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

  // Scope edits land before the status flips, so what gets approved is exactly what
  // actPhase will later be fenced to -- there is never a window where the proposal is
  // approved but still carries the pre-edit tool list.
  if (decision.approved && (decision.editedDescription !== undefined || decision.editedRequiredTools !== undefined)) {
    store.applyProposalEdits(proposal.id, {
      description: decision.editedDescription,
      requiredTools: decision.editedRequiredTools,
    });
  }

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
// Side-effecting tool access is hard-limited to exactly what the proposal
// declared. On top of that it always gets the same no-side-effect set the
// research phase gets freely: memory tools, the read-only integration tools
// (so it can read back what it just committed/deployed and self-check it),
// and WebSearch/WebFetch.
//
// The web tools are auto-granted rather than requiring the proposal to have
// named them: act is where the model actually writes code, and it routinely
// needs to check an API's current shape or a package's real export names
// mid-build. Making that depend on the model having predicted the need at
// proposal time meant it usually couldn't, and a proposal that forgot to ask
// had to be rejected and re-proposed. None of these can change anything
// outside this process, so granting them widens what the act phase can
// *learn*, never what it can *do* -- the fence that matters, on tools that
// create/commit/deploy, is still exactly proposal.required_tools.
//
// `allowedTools` is now the whole fence rather than one layer of three: this
// process owns tool dispatch outright, so a tool missing from the list is never
// described to the model and is refused if it names one anyway. See agent-loop.ts.

const ACT_SYSTEM = [
  BASE_SYSTEM,
  "You are in the ACT phase, executing a proposal a human has approved. This is the only phase where your tool calls change anything real -- repos, deployments, live sites.",
  "You are fenced to exactly the tools the approved proposal named, plus memory and read-only tools. That fence is the whole reason you are trusted to run unattended: do the approved work and nothing beyond it.",
  "You cannot run, build or test the code you write. Compensate by re-reading it before you commit and by reading back what actually landed afterwards.",
].join("\n");

const ACT_MAX_TURNS = 60;

/**
 * Set while an act phase is executing, so the operator's abort button has something to
 * cancel. Aborting stops the model mid-run: whatever side effects already landed stay
 * landed (there is no rollback), but nothing further is attempted, and reflect is skipped
 * because the run didn't reach an outcome.
 */
let actAbortController: AbortController | null = null;

async function actPhase(proposal: ProposalRow): Promise<void> {
  const requiredTools = proposal.required_tools.split(",").map((s) => s.trim()).filter(Boolean);
  const allowedTools = [
    ...new Set([
      ...MEMORY_TOOLS,
      ...READONLY_INTEGRATION_TOOLS,
      ...READONLY_BUILTIN_TOOLS,
      ...requiredTools,
    ]),
  ];
  const abortController = new AbortController();
  actAbortController = abortController;

  await runPhase({
    phase: "act",
    proposalId: proposal.id,
    prompt: [
      `Execute approved proposal #${proposal.id}: ${proposal.description}`,
      `The only tools that can change anything real are the ones this proposal was approved for: ${requiredTools.join(", ")}. On top of those you always have memory tools for logging/recall, the read-only integration tools (github_read_repo, github_read_file, github_search_repos, vercel_list_projects, vercel_get_project, netlify_list_sites, netlify_get_site) for checking real state, and WebSearch/WebFetch.`,
      `Use WebSearch/WebFetch while you build, not just before: check a library's current API, a package's real export names, or a config format rather than writing what you half-remember. You have no build step to catch a wrong import.`,
      `This is a real deliverable, not a stub -- fully implement the scope described above. Do not leave placeholder/TODO files, an empty repo, or a README-only scaffold standing in for the actual code.`,
      `You have no build or compile step available -- you cannot run the code you write. Before each commit, deliberately re-read every file you're about to write: confirm every import resolves to a file actually being committed, that the syntax is valid, and that package.json's dependencies/scripts match what the code actually uses.`,
      `After committing (and deploying, if applicable), use the read-only tools above to read back what actually landed -- confirm no file is missing, truncated, or empty, and that the deploy succeeded -- before you call outcome_record.`,
      `When finished, call outcome_record with the real numbers -- do not estimate, report what actually happened.`,
    ].join("\n"),
    system: ACT_SYSTEM,
    allowedTools,
    maxTurns: ACT_MAX_TURNS,
    signal: abortController.signal,
  }).finally(() => {
    // Only clear if this run still owns the slot -- a later act phase may have claimed it.
    if (actAbortController === abortController) actAbortController = null;
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
    system: REFLECT_SYSTEM,
    allowedTools: [...MEMORY_TOOLS],
    maxTurns: REFLECT_MAX_TURNS,
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
  reportExecutionState(runningProposalId, runQueue.map((r) => r.proposal.id));
  try {
    if (next.wasScheduled) {
      emitAgentEvent({ type: "scheduled_run_starting", proposal: next.proposal });
    }
    await actPhase(next.proposal);
    // Reflect only after an act phase that actually ran to completion -- an aborted or
    // failed act throws past this, so there's no outcome for it to draw a lesson from.
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
    reportExecutionState(null, runQueue.map((r) => r.proposal.id));
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
    try {
      const decided = await humanReviewPhase(proposal);
      if (decided.status !== "approved") {
        console.log(`Proposal #${decided.id} rejected. Reason: ${decided.human_notes ?? "(none given)"}`);
        // Memory-only, no side effects, so this doesn't need the act queue's serialization.
        await reflectOnRejectionPhase(decided);
      }
    } catch (err) {
      console.error(`[review] proposal #${proposal.id} failed:`, err);
    }
  })();
}

// ---- main loop --------------------------------------------------------------

async function mainLoop() {
  const search = getSearchConfig();
  console.log(`Agent runner started. Domains: ${DOMAINS.join("; ")}. DB: ${DB_PATH}`);
  console.log(`Models: ${describeClients(llmByPhase).join(", ")}. Web search: ${search.mode}.`);
  if (search.mode === "none") {
    console.warn(
      "[search] No web search is configured -- research will run on WebFetch and the read-only " +
        "integrations alone. Set TAVILY_API_KEY or BRAVE_API_KEY, or AGENT_SEARCH_PROVIDER=native."
    );
  }
  await store.syncToQdrant();
  // Env values are the starting point; from here the operator's console owns them, so
  // every later read goes through getControlState() rather than the module constants.
  initControl({ domains: DOMAINS, cycleIntervalMs: CYCLE_INTERVAL_MS });
  startServer(store, SERVER_PORT);
  onReactiveTrigger((t) => void handleReactiveTrigger(t.proposalId));
  onRunNow(() => wakeCycle());
  onAbort((proposalId) => {
    if (actAbortController && runningProposalId === proposalId) {
      console.log(`[control] aborting act phase for proposal #${proposalId}`);
      actAbortController.abort();
    }
  });
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
    const control = getControlState();
    const pendingCount = store.listPendingProposals().length;

    if (control.paused) {
      console.log("Loop is paused by the operator; skipping research this cycle.");
    } else if (pendingCount >= MAX_PENDING_PROPOSALS) {
      console.log(`${pendingCount} proposals already pending review (max ${MAX_PENDING_PROPOSALS}); skipping research this cycle.`);
    } else {
      const proposals = await researchAndPlanPhase();
      if (proposals.length > 0) {
        for (const p of proposals) enqueueForReview(p);
      } else {
        console.log("No proposal this cycle.");
      }
    }

    // Re-read the interval each pass so an operator's change takes effect on the next
    // wait rather than only after a restart.
    const intervalMs = getControlState().cycleIntervalMs;
    const nextCycleAt = new Date(Date.now() + intervalMs).toISOString();
    emitAgentEvent({ type: "cycle_idle", nextCycleAt });
    await sleepUntilNextCycle(intervalMs);
  }
}

/** Resolves when the interval elapses, or early if the operator hits "run a cycle now". */
let wakeCycle: () => void = () => {};

function sleepUntilNextCycle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      wakeCycle = () => {};
      resolve();
    }
    wakeCycle = finish;
  });
}

mainLoop().catch((err) => {
  console.error(err);
  store.close();
  process.exit(1);
});
