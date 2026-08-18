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
import { runAgent, type AgentRunOptions, type AgentStopReason } from "./agent-loop.js";
import { verifyAct, type ActVerdict } from "./act-verification.js";
import { isAbortError } from "./aborted.js";
import { describeClients, getLlmClients } from "./llm/index.js";
import { isTruncationStop } from "./llm/types.js";
import { isConsoleOnlyMode } from "./console-mode.js";
import { getSearchConfig } from "./search/index.js";
import { ToolRegistry } from "./tools/registry.js";
import { buildWebTools } from "./tools/web.js";
import {
  MemoryStore,
  buildMemoryTools,
  compareByPriorityThenDue,
  goalTitleFromDomain,
  parseMonetization,
  parseSteps,
  preview,
  type GoalRow,
  type Priority,
  type ProposalRow,
} from "./memory-server.js";
import { buildIntegrationsTools } from "./integrations-server.js";
import { buildConnectorTools } from "./connectors/tools.js";
import { configuredConnectorTools, connectorOperation } from "./connectors/load.js";
import {
  MEMORY_TOOLS,
  READONLY_BUILTIN_TOOLS,
  READONLY_INTEGRATION_TOOLS,
  RESEARCH_OUTPUT_TOOLS,
  WRITE_INTEGRATION_TOOLS,
} from "./tool-catalog.js";
import { emitAgentEvent } from "./events.js";
import { hasPendingDecision, waitForDecision } from "./review-gateway.js";
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
import { createShutdown, SHUTDOWN_SIGNALS } from "./shutdown.js";
import { ControlSettingsWriter } from "./control-settings-writer.js";
import { getSetting, initSettings, onSettingsChanged } from "./settings.js";

const DOMAINS = (process.env.AGENT_DOMAINS ?? "micro-SaaS tool for developers (self-built and self-hosted),Chrome extension for developers,VS Code extension for developers")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);
// Console-only dev mode (`npm run start:console` / AGENT_CONSOLE_ONLY=1): serve the API and the
// web console against the real database, opened read-only, and run no agent loop. See the
// mainLoop branch below.
const CONSOLE_ONLY = isConsoleOnlyMode();
const DB_PATH = process.env.AGENT_DB_PATH ?? "./data/agent.db";
const CYCLE_INTERVAL_MS = Number(process.env.AGENT_CYCLE_INTERVAL_MS ?? 1000 * 60 * 60); // 1h default
const SERVER_PORT = Number(process.env.AGENT_SERVER_PORT ?? 4001);
// How often the scheduler checks for approved proposals whose next_run_at has
// arrived (scheduled/recurring ones -- immediate approvals skip this and run
// right away, see humanReviewPhase). Default: 15s.
const SCHEDULER_TICK_MS = Number(process.env.AGENT_SCHEDULER_TICK_MS ?? 15_000);

const store = new MemoryStore(DB_PATH, { readOnly: CONSOLE_ONLY });

/**
 * Where a settings write goes. Assigned below once the mode is known -- the real run writes
 * through the store, console-only through its narrow `ControlSettingsWriter`. It starts as a
 * no-op because settings have to be initialised before `resolveLlmClients()` runs at module
 * scope, and nothing can save one until the API server is listening.
 */
let persistSettings: (patch: Record<string, unknown>) => void = () => {};

// Before the LLM clients resolve, because provider and model are settings now: a stored
// value has to win over the env var by the time the first client is built, or the console's
// choice would apply only from the *second* start after it was made.
initSettings({ stored: store.loadSettings(), persist: (patch) => persistSettings(patch) });

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
//
// Skipped in console-only mode: no phase runs there, so requiring a provider key and a
// valid AGENT_MODEL just to look at the database would defeat the point of the mode.
//
// Resolved here only to fail fast on a bad .env; the phases don't hold on to the result.
// `getLlmClients()` re-derives itself whenever the provider/model settings change, so each
// phase picks up a console change when it starts -- a cycle already in flight finishes on
// the client it started with, and nothing depends on a notification arriving.
if (!CONSOLE_ONLY) loadConfigOrExit(getLlmClients);

onSettingsChanged((changed) => {
  const touchesModels = Object.keys(changed).some((key) => key.toLowerCase().includes("model") || key.toLowerCase().includes("provider"));
  if (!touchesModels || CONSOLE_ONLY) return;
  // Purely the log line: the switch itself happens in getLlmClients(), whether or not this
  // runs. An operator who changed a model wants to see that it landed.
  try {
    console.log(`[settings] models now: ${describeClients(getLlmClients()).join(", ")}`);
  } catch (err) {
    console.warn(`[settings] could not resolve the new model: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// One registry for the whole process; each phase gets a subset by name, never a
// different registry. buildWebTools() contributes WebFetch always and WebSearch only
// when an HTTP search provider is configured -- in native mode the provider searches
// server-side instead, and agent-loop.ts handles that from the same "WebSearch" grant.
// Connector tools are registered whether or not their credential is set, exactly like
// the hand-written integrations: an unconfigured one answers "Error: STRIPE_API_KEY is
// not set" in band. Gating *registration* on the key would mean a key filled in later
// needs a restart before the tool exists, which is the wrong trade -- what a missing
// credential should change is what the research phase is told about (see
// researchAllowedTools below), not what the process is capable of.
const registry = loadConfigOrExit(
  () =>
    new ToolRegistry([
      ...buildMemoryTools(store),
      ...buildIntegrationsTools(),
      ...buildConnectorTools(),
      ...buildWebTools(),
    ])
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

interface PhaseResult {
  finalText: string;
  costUsd: number;
  toolCalls: number;
  /** Every call the phase made, with the tool's own in-band error flag. Act verifies against this. */
  calls: { name: string; isError: boolean }[];
  /** How the run ended. `truncated` means the model was cut off, not that it finished. */
  stopReason: AgentStopReason;
  providerStopReason: string;
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
  nudge?: AgentRunOptions["nudge"];
}): Promise<PhaseResult> {
  // An aborted run still gets its cost and duration logged below -- spend already
  // incurred counts against profit whether or not the phase finished.
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let finalText = "";
  let costUsd = 0;
  // Returned so callers can tell "the model worked and concluded X" from "the model
  // returned nothing" -- both otherwise look like a phase that completed normally.
  let toolCalls = 0;
  // The calls themselves, not just the count: act verifies the approved plan against them.
  const calls: { name: string; isError: boolean }[] = [];
  let stopReason: AgentStopReason = "end_turn";
  let providerStopReason = "";

  // Unreachable in console-only mode -- nothing calls a phase there -- but the check keeps
  // that a stated invariant rather than a confusing config error if something ever does.
  if (CONSOLE_ONLY) throw new Error("No model client: this process is running console-only (--console-only).");
  // Read once, at the top: the phase runs on one model from here to the ledger row below,
  // even if the operator changes the setting while it's in flight.
  const client = getLlmClients()[opts.phase];

  emitAgentEvent({ type: "phase_start", phase: opts.phase, proposalId: opts.proposalId });

  // Counted so a shutdown can wait for the unwinding below rather than closing the database
  // out from under a phase that is still writing its ledger row.
  phasesInFlight++;

  try {
    const result = await runAgent({
      client,
      registry,
      system: opts.system,
      prompt: opts.prompt,
      allowedTools: opts.allowedTools,
      maxTurns: opts.maxTurns,
      signal: opts.signal,
      nudge: opts.nudge,
      // Accumulated per turn rather than read off the result, so an abort or a crash
      // mid-phase still records what was already spent.
      onTurnCost: (usd) => {
        costUsd += usd;
      },
      onAssistantText: (text) => {
        console.log(`[${opts.phase}] model: ${preview(text, 300)}`);
        emitAgentEvent({ type: "model_text", phase: opts.phase, proposalId: opts.proposalId, text });
      },
      onToolCall: (toolName, input, output, isError) => {
        toolCalls++;
        calls.push({ name: toolName, isError });
        store.logAction(opts.proposalId, opts.phase, toolName, input, output);
        console.log(`[${opts.phase}] tool: ${toolName} ${preview(input)}`);
        emitAgentEvent({ type: "tool_call", phase: opts.phase, proposalId: opts.proposalId, toolName, input });
      },
    });
    finalText = result.finalText;
    stopReason = result.stopReason;
    providerStopReason = result.providerStopReason;
    // Logged for every phase, not just the failures. The provider's own word for why the model
    // stopped was computed on every turn and read by nothing, so the only way to find out after
    // the fact was to not be able to.
    console.log(
      `[${opts.phase}] stopped: ${result.stopReason} (provider finish_reason="${result.providerStopReason}") after ${result.turns} turn(s), ${toolCalls} tool call(s).`
    );
    if (result.stopReason === "max_turns") {
      console.warn(`[${opts.phase}] hit the ${opts.maxTurns}-turn limit; stopping with whatever it had done so far.`);
    }
    if (result.stopReason === "truncated") {
      console.warn(
        `[${opts.phase}] the model was cut off at the output limit and never finished; treat this run as incomplete.`
      );
    }
  } finally {
    phasesInFlight--;
    // In the finally so an aborted or failed phase is still accounted for: the spend
    // and the tool calls that already happened are real either way, and a phase that
    // vanished from the ledger because it crashed would understate what the loop cost.
    // This is also what a graceful shutdown exists to reach -- an unhandled Ctrl-C skips
    // every finally in the process, so the whole cycle's spend simply disappeared.
    console.log(`[${opts.phase}] done in ${((Date.now() - t0) / 1000).toFixed(1)}s, cost $${costUsd.toFixed(4)}`);
    store.logRun(opts.proposalId, opts.phase, costUsd, Date.now() - t0, startedAt, client.provider, client.model);
    emitAgentEvent({
      type: "phase_done",
      phase: opts.phase,
      proposalId: opts.proposalId,
      costUsd,
      durationMs: Date.now() - t0,
    });
  }

  return { finalText, costUsd, toolCalls, calls, stopReason, providerStopReason };
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
//
// Computed per cycle rather than fixed at module load: a connector whose credential
// isn't set is dropped from the grant, so the model is never shown a read tool that
// can only answer "KEY is not set" -- and a credential filled in while the loop runs
// takes effect on the next cycle instead of the next restart.
function availableIntegrationTools(): { read: string[]; write: string[] } {
  const configured = new Set(configuredConnectorTools());
  // A native integration is always "available" here -- it reports its own missing token
  // in band. Only manifest-declared connectors are filtered, because there are many of
  // them and most operators will have keys for a few.
  const available = (name: string) => !connectorOperation(name) || configured.has(name);
  return {
    read: READONLY_INTEGRATION_TOOLS.filter(available),
    write: WRITE_INTEGRATION_TOOLS.filter(available),
  };
}

function researchAllowedTools(): string[] {
  return [
    ...MEMORY_TOOLS,
    ...RESEARCH_OUTPUT_TOOLS,
    ...READONLY_BUILTIN_TOOLS,
    ...availableIntegrationTools().read,
  ];
}

/** `mcp__integrations__github_read_repo` -> `github_read_repo`, for prose that reads better short. */
function unqualified(toolName: string): string {
  return toolName.replace(/^mcp__[a-z_]+__/, "");
}

const RESEARCH_SYSTEM = [
  BASE_SYSTEM,
  "You are in the RESEARCH+PLAN phase. Nothing you do here touches the real world: you can read the web, read existing repos and deployments, and write to your own memory. That is all.",
  "Your only output that matters is proposals. You cannot execute anything in this phase, and a proposal you create will sit until a human approves it.",
].join("\n");

const RESEARCH_MAX_TURNS = 60;

/** How many existing proposals to show research+plan. Newest first -- old ones are the least likely to be re-proposed. */
const OPEN_PROPOSAL_DIGEST_LIMIT = 30;

/** Per goal, how much already-known material to put in front of research before it starts. */
const LESSON_DIGEST_PER_GOAL = 4;
const SATURATION_DIGEST_PER_GOAL = 8;

/**
 * Empty cycles before a goal is told to look sideways rather than harder.
 *
 * The store shows five consecutive cycles producing nothing on the same three lanes before
 * anyone intervened, so this fires well before that -- but not on the first quiet cycle, which
 * is a normal result the prompt explicitly allows.
 */
const EXPLORE_AFTER_EMPTY_CYCLES = 3;

/**
 * What research already knows, put in front of it rather than left for it to ask about.
 *
 * `openProposalDigest` below makes this argument for proposals -- "a duplicate has to be
 * prevented on every cycle, and a tool only helps on the cycles the model remembers to call it"
 * -- and it applies unchanged to lessons and dead ends. The prompt has always *told* research to
 * call lesson_search and research_note_search first; roughly a third of the notes on file are
 * "I checked, it's saturated", and cycles kept re-checking them anyway. Being told is weaker
 * than being shown.
 *
 * Both digests are per goal and deliberately terse -- one line each. They're a floor, not a
 * replacement: the search tools are still granted, and still the way to get the full text.
 */
async function lessonDigest(goals: GoalRow[]): Promise<string> {
  // Deduped across goals. Many lessons are operational rather than lane-specific ("check the
  // credential exists before proposing work that needs it"), so they match every goal and would
  // otherwise be repeated once per goal -- the same four paragraphs four times, crowding out the
  // digests that actually differ.
  const seen = new Set<number>();
  const sections: string[] = [];
  for (const goal of goals) {
    const lessons = (await store.searchLessons(`${goal.title}\n${goal.brief}`, LESSON_DIGEST_PER_GOAL)).filter(
      (l) => !seen.has(l.id)
    );
    if (lessons.length === 0) continue;
    for (const l of lessons) seen.add(l.id);
    const lines = lessons.map((l) => `  - #${l.id} (confidence ${l.confidence.toFixed(1)}): ${preview(l.lesson, 220)}`);
    sections.push(`${goal.title}:\n${lines.join("\n")}`);
  }
  return sections.join("\n");
}

function saturationDigest(goals: GoalRow[]): string {
  const seen = new Set<number>();
  const sections: string[] = [];
  for (const goal of goals) {
    const notes = store.listSaturatedNotes(goal.id, SATURATION_DIGEST_PER_GOAL).filter((n) => !seen.has(n.id));
    if (notes.length === 0) continue;
    for (const n of notes) seen.add(n.id);
    const lines = notes.map((n) => `  - ${n.fetched_at.slice(0, 10)} #${n.id}: ${preview(n.topic, 110)}`);
    sections.push(`${goal.title}:\n${lines.join("\n")}`);
  }
  // A goal with no goal_id-matched notes falls back to the unscoped recent set, so a store full
  // of legacy unassigned notes still contributes something rather than nothing.
  if (sections.length === 0) {
    const notes = store.listSaturatedNotes(null, SATURATION_DIGEST_PER_GOAL * 2);
    if (notes.length === 0) return "";
    return notes.map((n) => `  - ${n.fetched_at.slice(0, 10)} #${n.id}: ${preview(n.topic, 110)}`).join("\n");
  }
  return sections.join("\n");
}

/**
 * The goals that have gone quiet, with a vector-derived steer for each.
 *
 * This is the anti-lock-in half. A lane that keeps coming up empty doesn't need to be researched
 * harder, and the honest options are to look adjacent to it or to say so -- which is what
 * `goal_suggest` is for. The steer comes from findUnexploredDirections: notes close to the goal
 * but unlike the dead ends already recorded for it, which is a different question from anything
 * the model can ask with the search tools it has.
 */
async function explorationMandate(goals: GoalRow[]): Promise<string> {
  const health = new Map(store.goalHealth().map((h) => [h.goal_id, h]));
  const stalled = goals.filter((g) => (health.get(g.id)?.empty_cycles ?? 0) >= EXPLORE_AFTER_EMPTY_CYCLES);
  if (stalled.length === 0) return "";

  const sections: string[] = [];
  for (const goal of stalled) {
    const empty = health.get(goal.id)?.empty_cycles ?? 0;
    const directions = await store.findUnexploredDirections(goal, 4);
    const steer =
      directions.length > 0
        ? `\n  Findings here that are NOT dead ends, and are the most likely places left to look:\n` +
          directions.map((d) => `    - #${d.id}: ${preview(d.topic, 110)}`).join("\n")
        : "";
    sections.push(`- "${goal.title}": ${empty} research cycles since it last produced a proposal.${steer}`);
  }
  return sections.join("\n");
}

/**
 * The research phase's view of what has already been proposed.
 *
 * Without this it has none: `action_history_search` only covers work that already *ran*
 * (approved proposals with act-phase actions), and `proposal_status` needs an id the model
 * has no way to know. So everything sitting in the review queue, and everything approved but
 * not yet executed, was invisible -- which is exactly how a cycle ends up re-proposing an
 * idea that's already pending. Injected as prompt context rather than offered as a tool: a
 * duplicate has to be prevented on every cycle, and a tool only helps on the cycles the model
 * remembers to call it.
 */
function openProposalDigest(): string {
  const open = store
    .listAllProposals()
    .filter((p) => p.status === "pending" || p.status === "approved")
    .slice(0, OPEN_PROPOSAL_DIGEST_LIMIT);
  if (open.length === 0) return "";

  const lines = open.map((p) => {
    // Descriptions are Markdown whose first line is a bold headline -- that line alone
    // identifies the idea, and the bullets underneath would bloat the prompt for no gain.
    const headline = p.description.split("\n").find((l) => l.trim().length > 0) ?? p.description;
    const state = p.status === "pending" ? "awaiting review" : store.hasActed(p.id) ? "already built" : "approved, not yet run";
    return `- #${p.id} [${p.domain}] (${state}): ${preview(headline.replace(/[*_#`]/g, "").trim(), 160)}`;
  });
  return lines.join("\n");
}

async function researchAndPlanPhase(): Promise<ProposalRow[]> {
  const beforeIds = new Set(store.listPendingProposals().map((p) => p.id));
  const goals = store.activeGoals();
  // A directive steers exactly one cycle, then clears itself -- it's a nudge for this
  // run, not a standing instruction that quietly reshapes every future cycle. It can
  // only redirect what gets researched; the output is still a proposal needing approval.
  const directive = consumeDirective();
  const openProposals = openProposalDigest();
  const lessons = await lessonDigest(goals);
  const saturated = saturationDigest(goals);
  const exploration = await explorationMandate(goals);

  const { finalText, toolCalls } = await runPhase({
    phase: "research_plan",
    proposalId: null,
    prompt: [
      // Each goal's brief verbatim, not a joined list of names. The brief is where the operator
      // put the actual instructions ("research in Swedish, check Fortnox/Bokio first"), which
      // used to be crammed into the same string that served as the grouping key and so arrived
      // as a label rather than as direction.
      `Goals to research this cycle (pick whichever look most promising -- you don't need to cover all of them evenly):`,
      goals.map((g) => `- ${g.title}${g.brief && g.brief !== g.title ? `\n    ${g.brief}` : ""}`).join("\n"),
      `When you record anything against a goal -- a proposal's \`domain\`, a lesson's \`domain\`, a note's \`domain\` -- use that goal's title above exactly as written. Inventing a new phrasing each cycle is how the same lane ended up recorded under thirteen different names, none of which could be matched against each other.`,
      ...(directive ? [`The operator left a directive for this cycle -- weight it heavily: ${directive}`] : []),
      ...(openProposals
        ? [
            `Proposals that already exist -- do NOT propose any of these again, or a near-identical variant of one (same product, same audience, reworded):\n${openProposals}\nIf one of them is the right direction, the useful move is a concrete next step on it -- say which #id it builds on in your description -- not a second proposal for the same thing. A pending one hasn't been rejected; it just hasn't been reviewed yet, and re-proposing it only buries the original.`,
          ]
        : []),
      ...(lessons ? [`Lessons already learned that apply here. Treat these as settled unless this cycle turns up something that contradicts one -- in which case call lesson_reinforce with direction "contradicted" rather than quietly working around it:\n${lessons}`] : []),
      ...(saturated
        ? [
            `Ground already checked and found saturated or dead. Do NOT spend this cycle re-confirming any of it -- that has happened for several cycles running and produced nothing:\n${saturated}\nIf you believe one of these is worth revisiting, say specifically what changed since that date; "let me check again" is not a reason.`,
          ]
        : []),
      ...(exploration
        ? [
            `These goals have gone quiet:\n${exploration}\nFor each, do NOT simply search the same ground harder. Either find a genuinely different angle within the goal -- a different audience, buyer, geography or price point -- or, if the lane really does look played out, call goal_suggest with an adjacent direction that looks live and say what you saw that suggests it. A suggested goal is inert until the operator accepts it, so it costs them nothing to consider and does not change what you work on this cycle.`,
          ]
        : []),
      `The digests above are a floor, not the whole record. Call lesson_search and research_note_search for anything you're about to look into -- both do semantic matching, so they surface relevant history even when your wording doesn't match the original.`,
      `Also call action_history_search for each goal -- it shows what's actually been built/deployed/committed on approved proposals so far, so you don't propose duplicate work (e.g. a second repo for something already shipped). Prefer proposing the next step on existing work over starting over.`,
      `You can use the read-only tools ${availableIntegrationTools().read.map(unqualified).join(", ")} to check the existing landscape (competing projects, your own prior projects, and whether anything already shipped is getting traffic or earning) before proposing.`,
      `Research for concrete, boundable opportunities to earn money. Use WebSearch/WebFetch and the read-only integration tools above. Save distilled findings with research_note_add as you go, and set \`kind\` on each one -- 'gap' when you find something underserved, 'saturated' when you check a space and it is already well covered. Marking the dead ends honestly is what stops a future cycle spending itself re-checking them, so they are worth recording even though they feel like nothing.`,
      `When you have specific ideas, call proposal_create for each one worth a human's attention -- typically 1, up to 3 per cycle if multiple goals turned up genuinely strong, distinct opportunities. Don't pad the count with weak ideas just to fill a quota.`,
      `Every proposal has to say how it makes money, in the \`monetization\` block: who specifically pays, at what price, and through what mechanism the first payment is actually collected. That mechanism has to exist today and be reachable either by an act-phase tool or by the operator -- a hosted payment link, a named affiliate programme you checked is open to new applicants, a specific ad network. "Add payments later", "monetize through partnerships" and "we'll figure out pricing" are the kinds of answer that get a proposal rejected, and rightly.`,
      `\`steps\` is the ordered path from approval to that first dollar. Include the steps only a human can do (registering for the affiliate programme, pointing a domain, verifying a sending domain) with owner "human" -- leaving them out doesn't make them unnecessary, it just hides that the plan depends on them. For an agent step, name the tool it needs; that tool must also be in requiredTools, since the act phase is fenced to exactly that list and a step needing anything else cannot run.`,
      `Each proposal needs a real cost/time/upside estimate and the exact tool names execution would need. Built-in tools are unprefixed (e.g. 'WebSearch'). MCP tools need their full qualified name -- the act-phase write tools available are: ${availableIntegrationTools().write.join(", ")}. For GitHub work: prefer github_commit_files (one commit, many files) over repeated github_commit_file calls; and either commit straight to the default branch, or if you use github_create_pr, list github_merge_pr in required_tools too and merge it during the act phase -- an approved proposal has no further GitHub-side review to wait for, so an unmerged PR just leaves the default branch empty.`,
      `Then stop -- do not act on any proposal, a human reviews each one next.`,
      `If nothing concrete and boundable comes out of the research, don't force a proposal -- just stop.`,
    ].join("\n"),
    system: RESEARCH_SYSTEM,
    allowedTools: researchAllowedTools(),
    maxTurns: RESEARCH_MAX_TURNS,
    signal: shutdownController.signal,
  });

  const created = store.listPendingProposals().filter((p) => !beforeIds.has(p.id));

  // Proposing nothing is allowed -- the prompt explicitly tells it not to force a weak
  // proposal -- but several quiet cycles in a row look exactly like a stuck loop from the
  // console. Emit the model's own stated reason so the operator can tell "it researched and
  // found nothing worth your time" from "it never ran", and act on it (the domains, a
  // directive and lesson muting are all levers for the first case).
  if (created.length === 0) {
    emitAgentEvent({
      type: "no_proposal",
      reason: preview(finalText, 400) || "(the model ended the phase without saying why)",
      toolCalls,
    });
  }

  return created;
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
    const openProposals = openProposalDigest();

    await runPhase({
      phase: "research_plan",
      proposalId: proposal.id,
      prompt: [
        `Proposal #${proposal.id} in domain "${proposal.domain}" was marked "needs refinement" by a human reviewer after its deliverable was built: ${proposal.description}`,
        `Call lesson_search and research_note_search for this domain first -- don't re-research what's already known.`,
        `Investigate what's likely missing or broken -- re-read the shipped repo with github_read_repo/github_read_file if that helps.`,
        ...(openProposals
          ? [
              `Proposals that already exist -- don't duplicate one of these. A refinement is a tightly-scoped next step on #${proposal.id}, never a re-proposal of it:\n${openProposals}`,
            ]
          : []),
        `If you find something concrete and boundable, call proposal_create for a tightly-scoped follow-up fix addressing the refinement need.`,
        `If there isn't enough signal yet to propose something concrete, save a research_note explaining what's unclear and stop -- don't force a proposal.`,
      ].join("\n"),
      system: RESEARCH_SYSTEM,
      allowedTools: researchAllowedTools(),
      maxTurns: RESEARCH_MAX_TURNS,
      signal: shutdownController.signal,
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
    signal: shutdownController.signal,
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

/**
 * The monetization block and step list as the act phase should see them: the plan a human
 * said yes to, restated so execution follows it rather than re-deriving one from the prose.
 *
 * Human-owned steps are included and explicitly marked as not the agent's to do. Dropping
 * them would read as a shorter plan rather than a plan with a dependency in it, and the
 * agent claiming an outcome while a human step is outstanding is exactly the overstatement
 * outcome_record is supposed to avoid. Empty for a proposal created before these fields
 * existed, which is why this returns lines to spread rather than a string.
 */
function approvedPlanBrief(proposal: ProposalRow): string[] {
  const monetization = parseMonetization(proposal);
  const steps = parseSteps(proposal);
  const lines: string[] = [];

  if (monetization) {
    lines.push(
      `How this is supposed to make money (${proposal.revenue_model ?? "unspecified"}): ${monetization.whoPays} pays ${monetization.pricePoint}. Path to the first dollar: ${monetization.pathToFirstDollar}. Build toward that specifically -- it is what the proposal was approved on.`
    );
  }
  if (steps.length > 0) {
    lines.push(
      `The approved plan, in order:\n${steps
        .map(
          (s, i) =>
            `  ${i + 1}. [${s.owner}] ${s.title}${s.tool ? ` (${unqualified(s.tool)})` : ""} -- done when: ${s.doneWhen}`
        )
        .join("\n")}`,
      `Do the [agent] steps. The [human] ones are not yours to do and you have no tool for them -- when you reach one, note in outcome_record that it is outstanding rather than reporting the work as complete or pretending it was done.`
    );
  }
  return lines;
}

/**
 * Runs the approved work, then checks that it actually got done.
 *
 * The check is the point. Before it, this function returned as soon as `runPhase` did and the
 * loop went straight to reflect -- so an act phase that created a repo and then stopped, which
 * is what happened to proposal #27, was indistinguishable from one that built and deployed the
 * whole thing. The verdict is returned so the caller can hand reflect an honest description of
 * what it is reflecting on; see act-verification.ts for what "done" is decided from.
 *
 * Deliberately **not** a retry. Re-running act on a phase that half-executed would repeat
 * whatever side effects already landed, and the loop's whole safety story is that side effects
 * happen once, inside a human-approved fence. An incomplete run is reported and left for the
 * operator, exactly like a rejected proposal.
 */
async function actPhase(proposal: ProposalRow): Promise<ActVerdict> {
  const requiredTools = proposal.required_tools.split(",").map((s) => s.trim()).filter(Boolean);
  const readOnlyTools = availableIntegrationTools().read;
  const allowedTools = [
    ...new Set([
      ...MEMORY_TOOLS,
      ...readOnlyTools,
      ...READONLY_BUILTIN_TOOLS,
      // requiredTools is unfiltered on purpose: this is the approved fence, and a tool
      // whose credential is missing must report that itself rather than vanish from a
      // grant the human signed off on.
      ...requiredTools,
    ]),
  ];
  const abortController = new AbortController();
  actAbortController = abortController;

  // Before the model is called, not after: everything between here and the verdict below --
  // an abort, a crash, the machine going away -- leaves the row saying `running`, which the
  // next startup reaps into `interrupted`. Without this marker an act phase that died halfway
  // is indistinguishable from one that never started, and the proposal sits approved forever
  // looking like it's still queued.
  store.markActStarted(proposal.id);

  const steps = parseSteps(proposal);

  const result = await runPhase({
    // Consulted when the model stops calling tools, before the run is allowed to end. Twice the
    // act phase has read everything it needed, announced "now I'll write the full prototype and
    // commit it in one call", and returned nothing -- and the phase ended there with an empty
    // repo. The plan says exactly which tools were meant to run, so "it stopped early" is a fact
    // here, not a guess, and telling the model beats writing the failure down and moving on.
    //
    // Only ever names what's outstanding, and only tools already in the approved fence. It
    // cannot widen anything: a nudge is text, and the model still can't call what it wasn't
    // granted. Nor can it cause a repeat -- a step whose tool already ran successfully isn't
    // mentioned.
    nudge: ({ calls, stopReason: providerStop }) => {
      const check = verifyAct(steps, { toolCalls: calls, stopReason: "end_turn" });
      if (check.unrunSteps.length === 0 && check.outcomeRecorded) return null;

      const outstanding = check.unrunSteps.map((s) => `  - step ${s.position}: ${s.title} -- call ${unqualified(s.tool)}`);
      return [
        `Stop. You have not finished, and this run does not end until you have.`,
        ...(isTruncationStop(providerStop)
          ? [
              `Your last turn was cut off at the output limit, so whatever you were writing never arrived. Commit the files in several smaller ${unqualified("mcp__integrations__github_commit_files")} calls instead of one large one.`,
            ]
          : []),
        ...(outstanding.length > 0
          ? [`These approved steps have not run:`, ...outstanding, `Make those calls now. Do not describe them -- call them.`]
          : []),
        ...(check.outcomeRecorded ? [] : [`Then call outcome_record with what actually happened.`]),
        `If a step genuinely cannot be done, call outcome_record saying so plainly. What you must not do is stop silently.`,
      ].join("\n");
    },
    phase: "act",
    proposalId: proposal.id,
    prompt: [
      `Execute approved proposal #${proposal.id}: ${proposal.description}`,
      // The plan the human actually approved. Until this was passed through, the act phase
      // never saw the steps at all -- it re-derived an approach from the description and
      // could diverge from the one that got a yes.
      ...approvedPlanBrief(proposal),
      `The only tools that can change anything real are the ones this proposal was approved for: ${requiredTools.join(", ")}. On top of those you always have memory tools for logging/recall, the read-only integration tools (${readOnlyTools.map(unqualified).join(", ")}) for checking real state, and WebSearch/WebFetch.`,
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

  const verdict = verifyAct(steps, {
    toolCalls: result.calls,
    stopReason: result.stopReason,
    providerStopReason: result.providerStopReason,
  });
  store.recordActVerdict(proposal.id, verdict);
  if (verdict.complete) return verdict;

  console.warn(`[act] proposal #${proposal.id} did not complete:\n  - ${verdict.problems.join("\n  - ")}`);
  emitAgentEvent({
    type: "act_incomplete",
    proposalId: proposal.id,
    problems: verdict.problems,
    toolCalls: result.toolCalls,
    stopReason: result.stopReason,
    providerStopReason: result.providerStopReason,
  });

  // Only when the agent recorded nothing at all. If it *did* call outcome_record and the plan
  // is still unfinished, its own account stands -- overwriting a self-reported outcome with a
  // second row would double-count in the scoreboard, and the event above already says the plan
  // didn't run. This row exists so the silent case stops being silent: #27's act phase left the
  // ledger with no outcome whatsoever, which reads as "hasn't reported yet", forever.
  //
  // Written by the orchestrator rather than the model on purpose -- recording what actually
  // happened is not a model-callable capability, and this is the same boundary the rest of the
  // outcome bookkeeping already sits on.
  if (!verdict.outcomeRecorded) {
    store.recordOutcome({
      proposalId: proposal.id,
      actualRevenue: 0,
      actualCost: result.costUsd,
      success: false,
      notes: [
        "Recorded by the orchestrator, not the agent: the act phase ended without calling outcome_record.",
        ...verdict.problems,
      ].join(" "),
    });
    emitAgentEvent({ type: "outcome_recorded", proposalId: proposal.id });
  }
  return verdict;
}

// ---- phase 4: reflect ---------------------------------------------------

async function reflectPhase(proposal: ProposalRow, verdict?: ActVerdict): Promise<void> {
  // Told the truth about what it's reflecting on. The old prompt asserted "has an outcome
  // recorded now" unconditionally, which for #27 was simply false -- act had recorded nothing,
  // and reflect was left to infer that from action_history_search or not at all.
  const incomplete =
    verdict && !verdict.complete
      ? [
          `The act phase did NOT complete the approved plan. What went wrong:\n  - ${verdict.problems.join("\n  - ")}`,
          `Draw the lesson from that failure, not from an imagined success. A partial build -- a repo created but never filled, a deploy that never ran -- is a failure to record honestly, not a partial win.`,
        ]
      : [];

  await runPhase({
    phase: "reflect",
    proposalId: proposal.id,
    prompt: [
      verdict && !verdict.complete
        ? `Proposal #${proposal.id} in domain "${proposal.domain}" has just finished its act phase.`
        : `Proposal #${proposal.id} in domain "${proposal.domain}" has an outcome recorded now.`,
      ...incomplete,
      `Call lesson_search for this domain first. If an existing lesson was confirmed or contradicted by this outcome, call lesson_reinforce on it instead of duplicating it.`,
      `Otherwise, call lesson_add exactly once with a generalized, reusable takeaway -- not a play-by-play retelling of what happened this one time.`,
    ].join("\n"),
    system: REFLECT_SYSTEM,
    allowedTools: [...MEMORY_TOOLS],
    maxTurns: REFLECT_MAX_TURNS,
    signal: shutdownController.signal,
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

// Ordering lives in memory-server.ts (`compareByPriorityThenDue`) so this and GET /api/queue
// can't disagree about what runs next -- see the note there.

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
  // Reported here, not just when the worker picks something up: `drainQueue` returns
  // immediately (a no-op) whenever the worker is already busy, so without this a proposal
  // queued behind a running build sat in `runQueue` for the build's whole 8-32 minutes
  // without ever showing in `/api/queue`'s "queued" list -- the console's Build queue page
  // looked like it never held more than the one thing already running.
  reportExecutionState(runningProposalId, runQueue.map((r) => r.proposal.id));
  void drainQueue();
}

function pickNext(): QueuedRun | undefined {
  if (runQueue.length === 0) return undefined;
  runQueue.sort((a, b) => compareByPriorityThenDue(a.proposal, b.proposal));
  return runQueue.shift();
}

/** The single worker: runs the best-ranked queued proposal, then recurses to drain anything else already due. */
async function drainQueue(): Promise<void> {
  // Nothing new starts once a shutdown is under way. An act phase is the one thing here that
  // touches the real world, and starting one we're about to abort would create side effects
  // with no chance of the follow-through that makes them safe.
  if (workerBusy || shuttingDown) return;
  const next = pickNext();
  if (!next) return;

  workerBusy = true;
  runningProposalId = next.proposal.id;
  reportExecutionState(runningProposalId, runQueue.map((r) => r.proposal.id));
  try {
    if (next.wasScheduled) {
      emitAgentEvent({ type: "scheduled_run_starting", proposal: next.proposal });
    }
    const verdict = await actPhase(next.proposal);
    // Reflect only after an act phase that actually ran to completion -- an aborted or
    // failed act throws past this, so there's no outcome for it to draw a lesson from.
    // A phase that *ran* but didn't finish the plan still reflects, and now gets told so.
    await reflectPhase(next.proposal, verdict);
  } catch (err) {
    // An abort is the operator stopping this build, or the process shutting down -- both are
    // things they asked for, so neither is an error. Reported as one, a clean Ctrl-C printed a
    // stack trace pointing at our own abort() directly above "Bye.". The row stays `running`
    // (markActStarted wrote it before the model was called) and the next startup reaps it.
    if (isAbortError(err)) {
      console.log(`[act] proposal #${next.proposal.id} interrupted; it is marked interrupted on the next start.`);
    } else {
      console.error(`[act] proposal #${next.proposal.id} failed:`, err);
    }
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

/**
 * Gives a review resolver to any pending proposal that doesn't have one.
 *
 * A proposal becomes visible the instant `proposal_create` writes the row, but it only becomes
 * *decidable* when `enqueueForReview` puts a resolver in the review gateway -- and that used to
 * happen only when the whole research phase returned. Since a phase routinely runs 10-15 minutes
 * after filing its first proposal, the console showed a pending proposal that answered
 * "No pending decision for this proposal" to every Approve click for the rest of the phase.
 * That is what happened to #30: filed 19:32:14, still un-approvable at 19:37 because the phase
 * that created it was still going.
 *
 * Written as a reconciliation sweep rather than a notification on create, because "the row is
 * pending and nothing is waiting on it" is the condition that actually matters, and it has more
 * causes than one: a research phase aborted midway, a reactive pass that threw, a decision
 * endpoint that raced a restart. Fixing only the notification would leave the rest.
 *
 * Runs on the scheduler interval, so worst case a new proposal is decidable ~15s after it exists.
 */
function reviewSweep(): void {
  for (const p of store.listPendingProposals()) {
    enqueueForReview(p);
  }
}

/**
 * Fire-and-forget: waits for this proposal's review independently of any others in flight.
 *
 * Guarded, because a proposal now reaches here from two directions -- `reviewSweep` within
 * seconds of it being written, and the research phase enqueueing everything it created when it
 * finally returns. A second `waitForDecision` would replace the first resolver, stranding that
 * promise and its `humanReviewPhase` forever.
 */
function enqueueForReview(proposal: ProposalRow): void {
  if (hasPendingDecision(proposal.id)) return;
  void (async () => {
    try {
      const decided = await humanReviewPhase(proposal);
      if (decided.status !== "approved") {
        console.log(`Proposal #${decided.id} rejected. Reason: ${decided.human_notes ?? "(none given)"}`);
        // Memory-only, no side effects, so this doesn't need the act queue's serialization.
        await reflectOnRejectionPhase(decided);
      }
    } catch (err) {
      // Same as the act queue: a shutdown mid-rejection-reflect is not a failure of this review.
      if (isAbortError(err)) {
        console.log(`[review] proposal #${proposal.id} interrupted by shutdown.`);
      } else {
        console.error(`[review] proposal #${proposal.id} failed:`, err);
      }
    }
  })();
}

// ---- main loop --------------------------------------------------------------

/**
 * Console-only mode: start the API server against the read-only store and stop there.
 *
 * No research cycle, no scheduler, no pending-review queue, no model client -- every one
 * of those exists to write something, and this mode exists to write nothing to *the record*:
 * no proposal, action, lesson, note, outcome or run can change here.
 *
 * The one exception is the three operator settings the next real run reads at startup --
 * domains, cycle interval, and the pause switch. Without them, retargeting the loop before
 * starting it meant hand-editing `control_settings` with a sqlite one-liner, because
 * AGENT_DOMAINS stops being the source of truth the first time the console sets domains.
 * They persist through `ControlSettingsWriter`, a connection that can reach three keys of one
 * table and nothing else -- the store itself stays read-only, so the guarantee that covers
 * everything else is untouched rather than relaxed and re-defended. See that module, and the
 * matching route allowlist in server.ts.
 */
function serveConsoleOnly(): void {
  console.log(`Console-only mode (--console-only). Serving ${DB_PATH} READ-ONLY; the agent loop is not running.`);
  console.log("No model API will be called; the only writable settings are domains, cycle interval and pause.");
  const saved = store.loadControlSettings();
  const settingsWriter = new ControlSettingsWriter(DB_PATH);
  // Seeding has to go through the writer here: the store is read-only, and an empty `goals`
  // table would otherwise leave this mode with nothing to retarget -- which is the one job it
  // has. Same derivation as the real run, just through the narrow connection.
  if (store.listGoals().length === 0) {
    for (const domain of saved.domains ?? DOMAINS) {
      settingsWriter.createGoal({ title: goalTitleFromDomain(domain), brief: domain });
    }
  }
  initControl({
    goals: goalSummaries(),
    cycleIntervalMs: saved.cycleIntervalMs ?? CYCLE_INTERVAL_MS,
    paused: saved.paused,
    // A directive read from the DB is still shown (it's part of control state), but this
    // mode's writer drops it, and the API refuses the route -- nothing here can queue one.
    directive: saved.directive,
    persist: (patch) => settingsWriter.save(patch),
  });
  // Settings are the same kind of thing as domains/interval/pause here: values the *next*
  // real run reads at startup. They go through the same narrow writer, which has its own
  // key allowlist -- the store stays read-only.
  persistSettings = (patch) => settingsWriter.saveSettings(patch);
  const server = startServer(store, SERVER_PORT, { settingsWriter });
  // Nothing here can be mid-write to the record -- that's the whole mode -- so this only has
  // to stop listening and close both connections. Registered all the same: an operator who
  // learns Ctrl-C is clean in one mode should not find it isn't in the other.
  extraClosers.push(() => settingsWriter.close());
  installSignalHandlers(server);
}

/** The goal fields the control layer carries, read fresh from the table it's the projection of. */
function goalSummaries() {
  return store.listGoals().map((g) => ({
    id: g.id,
    title: g.title,
    brief: g.brief,
    status: g.status,
    weight: g.weight,
  }));
}

async function mainLoop() {
  if (CONSOLE_ONLY) {
    serveConsoleOnly();
    return;
  }

  const search = getSearchConfig();
  console.log(`Agent runner starting. DB: ${DB_PATH}`);
  console.log(`Models: ${describeClients(getLlmClients()).join(", ")}. Web search: ${search.mode}.`);
  if (search.mode === "none") {
    console.warn(
      "[search] No web search is configured -- research will run on WebFetch and the read-only " +
        "integrations alone. Set TAVILY_API_KEY or BRAVE_API_KEY, or AGENT_SEARCH_PROVIDER=native."
    );
  }
  await store.syncToQdrant();
  // Env values seed a fresh DB; anything the operator has since set in the console wins and
  // is written back through `persist`, so a console change is no longer lost on restart.
  // From here every read goes through getControlState() rather than the module constants.
  const saved = store.loadControlSettings();
  // One-time move off the free-text domain list: a DB that has never had goals gets one per
  // configured domain, title split from brief. No-op on every subsequent start, so AGENT_DOMAINS
  // keeps its "seeds a fresh DB, loses to what the operator set" semantics -- the goals table is
  // simply what it now seeds.
  const seeded = store.seedGoalsFromDomains(saved.domains ?? DOMAINS);
  if (seeded > 0) {
    console.log(`[goals] seeded ${seeded} goal(s) from the configured domains -- edit them on the console's Goals page.`);
  }
  if (saved.paused) {
    console.warn("[control] starting PAUSED -- the loop was paused from the console and that persists.");
  }
  initControl({
    goals: goalSummaries(),
    cycleIntervalMs: saved.cycleIntervalMs ?? CYCLE_INTERVAL_MS,
    paused: saved.paused,
    directive: saved.directive,
    persist: (patch) => store.saveControlSettings(patch),
  });
  persistSettings = (patch) => store.saveSettings(patch);
  const server = startServer(store, SERVER_PORT);
  // Caught rather than voided: this runs a research phase under the shutdown signal, so a
  // Ctrl-C during one rejected a floating promise and took the process down as an unhandled
  // rejection -- mid-shutdown, before the handles were closed.
  onReactiveTrigger((t) => {
    handleReactiveTrigger(t.proposalId).catch((err: unknown) => {
      if (isAbortError(err)) return;
      console.error(`[reactive] proposal #${t.proposalId} failed:`, err);
    });
  });
  onRunNow(() => wakeCycle());
  onAbort((proposalId) => {
    if (actAbortController && runningProposalId === proposalId) {
      console.log(`[control] aborting act phase for proposal #${proposalId}`);
      actAbortController.abort();
    }
  });
  // The effective domains, not the env ones -- the console's "3 domains" and the feed's
  // startup line both read this, and reporting AGENT_DOMAINS here would describe lanes the
  // loop isn't actually researching once the operator has retargeted them.
  const effectiveDomains = getControlState().domains;
  console.log(`Domains: ${effectiveDomains.join("; ")}`);
  emitAgentEvent({ type: "run_started", domains: effectiveDomains });

  // Pick up any proposals left pending from a previous run -- all queued for
  // review in parallel, not one at a time.
  for (const leftover of store.listPendingProposals()) {
    enqueueForReview(leftover);
  }

  // Repair whatever the previous process left mid-flight, before the scheduler below gets a
  // look at it. Both halves matter and they do different things -- see reapAfterUncleanShutdown.
  const reaped = store.reapAfterUncleanShutdown();
  for (const stranded of reaped.interrupted) {
    console.warn(
      `[act] proposal #${stranded.id} was mid-act when the previous process stopped; marked interrupted. Whatever it already committed or deployed stands.`
    );
    emitAgentEvent({
      type: "act_incomplete",
      proposalId: stranded.id,
      problems: ["The act phase was still running when the previous process stopped, so it never finished or reported."],
      toolCalls: 0,
      stopReason: "interrupted",
    });
  }
  if (reaped.descheduled.length > 0) {
    // Said out loud because it is the difference between "the agent quietly re-committed
    // everything on restart" and "nothing happened until you asked" -- an operator who doesn't
    // know which of those they're in can't reason about what the repo contains.
    console.warn(
      `[act] descheduled ${reaped.descheduled.length} proposal(s) whose act phase had already started (#${reaped.descheduled
        .map((p) => p.id)
        .join(", #")}) so they don't silently re-run and repeat side effects. Check what landed, then POST /api/proposals/:id/rerun to resume one.`
    );
  }

  // Catch up on anything already due (scheduled/recurring proposals whose time
  // arrived while the process was down), then keep checking on an interval.
  schedulerTick();
  schedulerTimer = setInterval(() => {
    schedulerTick();
    reviewSweep();
  }, SCHEDULER_TICK_MS);
  installSignalHandlers(server);

  while (!shuttingDown) {
    const control = getControlState();
    const pendingCount = store.listPendingProposals().length;

    if (control.paused) {
      console.log("Loop is paused by the operator; skipping research this cycle.");
    } else if (pendingCount >= getSetting("maxPendingProposals")) {
      console.log(
        `${pendingCount} proposals already pending review (max ${getSetting("maxPendingProposals")}); skipping research this cycle.`
      );
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

// ---- graceful shutdown ------------------------------------------------------
//
// The sequence itself lives in shutdown.ts, against injected dependencies, so it can be tested
// without a signal -- see the note there on why firing one isn't an option on Windows. This is
// only the wiring.

const SHUTDOWN_GRACE_MS = 15_000;

/**
 * The signal research and reflect run under. They had none at all before this, which is why
 * killing the process during a research cycle silently lost that cycle's spend: nothing could
 * interrupt the in-flight HTTP request, so the `finally` that records the cost never ran.
 */
const shutdownController = new AbortController();
let shuttingDown = false;
/** In-flight `runPhase` calls -- what a shutdown waits on before closing the database. */
let phasesInFlight = 0;
let schedulerTimer: NodeJS.Timeout | null = null;
/** Anything else holding a database handle -- console-only mode's second, narrow connection. */
const extraClosers: (() => void)[] = [];

function installSignalHandlers(server?: { close(): unknown }): void {
  const shutdown = createShutdown({
    stopScheduler: () => {
      if (schedulerTimer) clearInterval(schedulerTimer);
    },
    closeServer: () => void server?.close(),
    // Both controllers: the shared one research and reflect listen on, and act's own -- which
    // is the same one the console's abort button fires, so an act phase can only ever be
    // interrupted through a path that already knows how to leave the record consistent.
    abortPhases: () => {
      shutdownController.abort();
      actAbortController?.abort();
    },
    wakeLoop: () => wakeCycle(),
    inFlight: () => phasesInFlight > 0 || workerBusy,
    closeHandles: () => {
      store.close();
      for (const close of extraClosers) close();
    },
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
    exit: (code) => process.exit(code),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    graceMs: SHUTDOWN_GRACE_MS,
  });

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      shuttingDown = true; // read by mainLoop's while and by drainQueue, synchronously
      void shutdown(signal);
    });
  }
}

mainLoop().catch((err: unknown) => {
  // Ctrl-C during a research cycle aborts the in-flight request, which rejects all the way out
  // here -- and this path used to print the stack and `process.exit(1)` immediately, racing the
  // shutdown sequence to the exit and beating it: a clean stop reported as a crash, with the
  // database closed by process teardown rather than by us. The shutdown owns the exit; leave.
  if (shuttingDown && isAbortError(err)) return;
  console.error(err);
  if (!shuttingDown) store.close();
  process.exit(1);
});
