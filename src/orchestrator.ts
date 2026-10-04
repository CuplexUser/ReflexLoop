// src/orchestrator.ts
//
// Drives agents through: RESEARCH -> HUMAN REVIEW -> DEEP DIVE -> REFLECT.
// No subagents anywhere -- the tool registry has no tool that spawns one, and the
// loop in agent-loop.ts only ever dispatches tools from that registry.
//
// This is a research agent. It never builds, launches, buys, publishes or contacts
// anyone: no tool in the registry changes anything outside its own database (see
// tool-catalog.ts). What a human approval buys is a deep dive -- a longer, read-only
// investigation of one idea that ends in a written feasibility report.
//
// The model behind this is whatever AGENT_PROVIDER/AGENT_MODEL name (OpenRouter,
// OpenAI, Anthropic, xAI or Moonshot); nothing in this file is provider-specific.
//
// Concurrency model: research runs one cycle at a time (on CYCLE_INTERVAL_MS),
// and can file more than one idea per cycle across the active goals. Every new
// idea immediately starts waiting for review in parallel with any others already
// pending -- a human can triage several at once. Once approved, an idea's deep
// dive and reflect run through a single priority-ordered queue, one at a time,
// which bounds spend and provider rate limits rather than guarding side effects.
//
// The deep dive keeps the persisted phase key "act" (runs.phase, actions.phase, the
// actModel setting, AGENT_ACT_*): that history predates the switch to research-only,
// and renaming the key would split one ledger column in two for no behavioral gain.
//
// Run with: npx tsx src/orchestrator.ts

import "dotenv/config";
import { runAgent, type AgentRunOptions, type AgentStopReason } from "./agent-loop.js";
import { deepDiveNudge, verifyDeepDive, type DeepDiveVerdict } from "./deep-dive.js";
import { isAbortError } from "./aborted.js";
import { describeClients, getLlmClients } from "./llm/index.js";
import { isConsoleOnlyMode } from "./console-mode.js";
import { getSearchConfig } from "./search/index.js";
import { ToolRegistry } from "./tools/registry.js";
import { buildWebTools } from "./tools/web.js";
import {
  MemoryStore,
  buildMemoryTools,
  compareByPriorityThenDue,
  goalTitleFromDomain,
  parseMarket,
  parseMonetization,
  parseSteps,
  preview,
  type GoalRow,
  type Priority,
  type ProposalRow,
  type ReportRow,
} from "./memory-server.js";
import { buildIntegrationsTools } from "./integrations-server.js";
import { buildConnectorTools } from "./connectors/tools.js";
import { configuredConnectorTools, connectorOperation } from "./connectors/load.js";
import {
  DEEP_DIVE_OUTPUT_TOOLS,
  MEMORY_TOOLS,
  READONLY_BUILTIN_TOOLS,
  READONLY_INTEGRATION_TOOLS,
  RESEARCH_OUTPUT_TOOLS,
} from "./tool-catalog.js";
import { emitAgentEvent } from "./events.js";
import { hasPendingDecision, waitForDecision } from "./review-gateway.js";
import {
  consumeDirective,
  getControlState,
  initControl,
  onAbort,
  onRunNow,
  reportExecutionState,
} from "./agent-control.js";
import { startNotifier } from "./notify.js";
import { startServer } from "./server.js";
import { createShutdown, SHUTDOWN_SIGNALS } from "./shutdown.js";
import { ControlSettingsWriter } from "./control-settings-writer.js";
import { getSetting, initSettings, onSettingsChanged } from "./settings.js";

const DOMAINS = (process.env.AGENT_DOMAINS ?? "low-startup-cost service businesses,underserved B2B niches for small businesses,consumer subscription or digital products")
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
// research is wide and cheap to get wrong, the deep dive (persisted phase key "act") is
// the longest and most source-heavy phase and the one whose report a human acts on, and
// reflect is two short memory calls. See the AGENT_*_PROVIDER / AGENT_*_MODEL overrides
// in llm/index.ts.
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
// the hand-written integrations: an unconfigured one answers "Error: DATAFORSEO_AUTH is
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

// Every tool list a phase is granted from lives in tool-catalog.ts, which is also where
// the "no tool here changes the outside world" guarantee is stated and checked.

/**
 * Shared framing for every phase. The Agent SDK supplied a system prompt of its own
 * (a coding-agent persona with filesystem tools); this loop has no such default, so
 * the operating rules that used to be implicit are stated here once instead of being
 * repeated in each phase prompt.
 */
const BASE_SYSTEM = [
  "You are an autonomous market-research agent. The operator gives you goals; you research them, file business ideas worth a human's attention (software or not), and when the operator approves one you investigate it in depth and write a feasibility report.",
  "You never build, launch, buy, publish or contact anyone. None of your tools changes anything outside your own memory: you read the web and public data sources, and you write notes, lessons, ideas and reports.",
  "You work entirely through the tools you are given. Only the tools listed for the current phase are available. Do not invent tool names or describe a tool call in prose instead of calling it.",
  "Be concrete and honest. Cite the source of every figure you rely on. Label estimates as estimates, and say \"unknown\" rather than guess. A well-evidenced \"this won't work\" is as useful to the operator as a promising idea.",
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

// ---- phase 1: research ------------------------------------------------------
//
// Returns every idea newly filed this cycle (0 to a few) -- research can favor
// whichever goal looks most promising rather than being forced to cover them
// evenly, and can surface more than one idea per cycle when several are strong.

// The read tools this cycle can use, shared by research and the deep dive.
//
// Everything a phase is granted is read-only or writes only to the agent's own memory
// DB, which is why research gets its whole list up front with no human in the loop.
// WebSearch is listed whether or not a local WebSearch tool exists -- in
// native mode agent-loop.ts reads this grant and turns on the provider's own
// server-side search instead. Nothing outside this list is described to the model
// or dispatchable by it; see the fence note in agent-loop.ts.
//
// Computed per cycle rather than fixed at module load: a connector whose credential
// isn't set is dropped from the grant, so the model is never shown a read tool that
// can only answer "KEY is not set" -- and a credential filled in while the loop runs
// takes effect on the next cycle instead of the next restart.
function availableReadTools(): string[] {
  const configured = new Set(configuredConnectorTools());
  // A native integration is always "available" here -- it reports its own missing token
  // in band. Only manifest-declared connectors are filtered, because there are several of
  // them and most operators will have keys for a few.
  return READONLY_INTEGRATION_TOOLS.filter((name) => !connectorOperation(name) || configured.has(name));
}

function researchAllowedTools(): string[] {
  return [...MEMORY_TOOLS, ...RESEARCH_OUTPUT_TOOLS, ...READONLY_BUILTIN_TOOLS, ...availableReadTools()];
}

/** `mcp__integrations__github_read_repo` -> `github_read_repo`, for prose that reads better short. */
function unqualified(toolName: string): string {
  return toolName.replace(/^mcp__[a-z_]+__/, "");
}

const RESEARCH_SYSTEM = [
  BASE_SYSTEM,
  "You are in the RESEARCH phase. Your outputs are research notes, lessons, and ideas filed with proposal_create for the operator to review.",
  "Filing an idea does not start anything. It waits for a human; if they approve it, a later deep dive investigates it further.",
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
 * The research phase's view of what has already been proposed, and how each idea fared.
 *
 * Without this it has none: `proposal_status` needs an id the model has no way to know. So
 * everything sitting in the review queue, and every verdict a deep dive reached, was invisible
 * -- which is exactly how a cycle ends up re-proposing an idea that's already pending, or one a
 * deep dive already found unviable. Injected as prompt context rather than offered as a tool: a
 * duplicate has to be prevented on every cycle, and a tool only helps on the cycles the model
 * remembers to call it.
 */
function openProposalDigest(): string {
  const reports = store.latestReportsByProposal();
  const open = store
    .listAllProposals()
    .filter((p) => p.status === "pending" || p.status === "approved")
    .slice(0, OPEN_PROPOSAL_DIGEST_LIMIT);
  if (open.length === 0) return "";

  const lines = open.map((p) => {
    // Descriptions are Markdown whose first line is a bold headline -- that line alone
    // identifies the idea, and the bullets underneath would bloat the prompt for no gain.
    const headline = p.description.split("\n").find((l) => l.trim().length > 0) ?? p.description;
    return `- #${p.id} [${p.domain}] (${ideaState(p, reports.get(p.id))}): ${preview(headline.replace(/[*_#`]/g, "").trim(), 160)}`;
  });
  return lines.join("\n");
}

function ideaState(p: ProposalRow, report: { verdict: string; viability_score: number } | undefined): string {
  if (p.status === "pending") return "awaiting review";
  if (report) return `deep-dived: ${report.verdict} ${report.viability_score}/5`;
  if (p.act_status === "running") return "deep dive running";
  // A build-mode proposal: approved and acted on before this agent became research-only.
  if (p.market_json === null && store.hasActed(p.id)) return "built (legacy)";
  return p.next_run_at ? "deep dive queued" : "approved, deep dive not finished";
}

async function researchAndPlanPhase(): Promise<ProposalRow[]> {
  const beforeIds = new Set(store.listPendingProposals().map((p) => p.id));
  const goals = store.activeGoals();
  // A directive steers exactly one cycle, then clears itself -- it's a nudge for this
  // run, not a standing instruction that quietly reshapes every future cycle. It can
  // only redirect what gets researched; the output is still an idea needing approval.
  const directive = consumeDirective();
  const openProposals = openProposalDigest();
  const lessons = await lessonDigest(goals);
  const saturated = saturationDigest(goals);
  const exploration = await explorationMandate(goals);
  const readTools = availableReadTools();

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
      `When you record anything against a goal -- an idea's \`domain\`, a lesson's \`domain\`, a note's \`domain\` -- use that goal's title above exactly as written. Inventing a new phrasing each cycle is how the same lane ended up recorded under thirteen different names, none of which could be matched against each other.`,
      ...(directive ? [`The operator left a directive for this cycle -- weight it heavily: ${directive}`] : []),
      ...(openProposals
        ? [
            `Ideas already on file -- do NOT propose any of these again, or a near-identical variant of one (same product, same buyer, reworded):\n${openProposals}\nA pending one hasn't been rejected; it just hasn't been reviewed yet, and re-proposing it only buries the original. A "drop" verdict from a deep dive is settled: do not re-pitch that idea unless you can name specific new evidence the deep dive did not have.`,
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
      `Research the market for each goal you pick: who the buyers are, what they pay for today, who already serves them and at what price, where demand shows up (search volume, forums, marketplaces, tenders), and what is underserved. Use WebSearch/WebFetch${readTools.length > 0 ? ` and the read-only data tools (${readTools.map(unqualified).join(", ")})` : ""}. Ideas do not have to be software.`,
      `Save distilled findings with research_note_add as you go, with \`kind\` set: 'gap' (underserved), 'demand' (evidence people want or pay for something), 'market_size', 'competitor', 'pricing', 'risk', or 'saturated' (you checked and it is already well covered). These notes are what the operator's market view of each goal is built from, and marking dead ends honestly is what stops a future cycle re-checking them.`,
      `When you have specific ideas, call proposal_create for each one worth a human's attention -- typically 1, up to 3 per cycle if multiple goals turned up genuinely strong, distinct opportunities. Don't pad the count with weak ideas just to fill a quota.`,
      `Every idea needs a \`market\` block: demand evidence with the URL you read it at, named competitors with their pricing, a market size with how you derived it, the key risks, and a 1-5 viability score with your confidence in it. Score honestly; the deep dive will check these claims.`,
      `Every idea also has to say how it makes money, in the \`monetization\` block: who specifically pays, at what price, and the mechanism that collects the first payment -- one a human operator could set up today (a payment link, a named affiliate programme you checked is open to new applicants, a specific marketplace or ad network). "Monetize through partnerships" and "we'll figure out pricing" are the kinds of answer that get an idea rejected. For an audience-first idea (an open-source or free tool, a community), use revenueModel "deferred", "open_core" or "sponsorship_donations", name the later mechanism, and make the validation signal adoption.`,
      `\`steps\` is the launch outline a human would follow, in order: the cheapest test that would validate demand first, ending at the first revenue.`,
      `Then stop -- a human reviews each idea next, and approved ones get a deeper investigation.`,
      `If nothing concrete comes out of the research, don't force an idea -- just stop.`,
    ].join("\n"),
    system: RESEARCH_SYSTEM,
    allowedTools: researchAllowedTools(),
    maxTurns: RESEARCH_MAX_TURNS,
    signal: shutdownController.signal,
  });

  const created = store.listPendingProposals().filter((p) => !beforeIds.has(p.id));

  // Filing nothing is allowed -- the prompt explicitly tells it not to force a weak idea --
  // but several quiet cycles in a row look exactly like a stuck loop from the console. Emit
  // the model's own stated reason so the operator can tell "it researched and found nothing
  // worth your time" from "it never ran", and act on it (the goals, a directive and lesson
  // muting are all levers for the first case).
  if (created.length === 0) {
    emitAgentEvent({
      type: "no_proposal",
      reason: preview(finalText, 400) || "(the model ended the phase without saying why)",
      toolCalls,
    });
  }

  return created;
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
  "You are in the REFLECT phase. You can only read and write your own memory -- no web access and no data sources.",
  "Write lessons that will still be useful to a future cycle looking at a different idea in the same domain. A retelling of this one event is not a lesson.",
].join("\n");

const REFLECT_MAX_TURNS = 10;

/**
 * A rejection is a signal too -- without this the agent learns nothing from being told no,
 * and the next cycle is free to re-propose the same idea. Runs the same memory-only reflect
 * grant as the post-deep-dive reflection; there is no report here, just the human's reason.
 */
async function reflectOnRejectionPhase(proposal: ProposalRow): Promise<void> {
  await runPhase({
    phase: "reflect",
    proposalId: proposal.id,
    prompt: [
      `Idea #${proposal.id} in domain "${proposal.domain}" was REJECTED by the human reviewer: ${proposal.description}`,
      `Their stated reason: ${proposal.human_notes?.trim() || "(none given)"}`,
      `Call lesson_search for this domain first. If an existing lesson already covers why this kind of proposal gets rejected, call lesson_reinforce on it rather than duplicating it.`,
      `Otherwise call lesson_add exactly once with a generalized takeaway about what makes an idea in this domain not worth approving -- something that would stop you re-proposing this same idea next cycle. Don't record the rejection as a play-by-play.`,
      `If no reason was given, infer nothing beyond the obvious and keep the lesson conservative -- a low-confidence, narrowly-worded note is better than a confident guess about why.`,
    ].join("\n"),
    system: REFLECT_SYSTEM,
    allowedTools: [...MEMORY_TOOLS],
    maxTurns: REFLECT_MAX_TURNS,
    signal: shutdownController.signal,
  });
}

async function humanReviewPhase(proposal: ProposalRow): Promise<ProposalRow> {
  console.log("\n=== Idea awaiting review ===");
  console.log(`#${proposal.id} [${proposal.domain}]`);
  console.log(proposal.description);
  console.log(
    `Expected: cost ${proposal.expected_cost}, time ${proposal.expected_time_hours}h, upside ${proposal.expected_upside}`
  );

  emitAgentEvent({ type: "proposal_pending", proposal });
  const decision = await waitForDecision(proposal.id);

  // A description edit lands before the status flips, so the deep dive investigates the
  // idea as the operator approved it, not as the model first pitched it.
  if (decision.approved && decision.editedDescription !== undefined) {
    store.applyProposalEdits(proposal.id, { description: decision.editedDescription });
  }

  store.decideProposal(proposal.id, decision.approved ? "approved" : "rejected", decision.notes);

  if (decision.approved) {
    // Priority/schedule/recurrence are set by the human right here, at the moment
    // they approve the idea -- never by the model, and never editable after the fact
    // except via cancelSchedule. A recurring deep dive re-investigates on an interval.
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

// ---- phase 3: deep dive -----------------------------------------------------
//
// What a human approval buys: a longer, read-only investigation of one idea that ends
// in a written feasibility report. The grant is the research phase's read tools plus
// `report_submit`, which only accepts a report for the idea being investigated. There
// is nothing to fence: no tool in the registry changes anything outside this process.

const DEEP_DIVE_SYSTEM = [
  BASE_SYSTEM,
  "You are in the DEEP DIVE phase, investigating one idea a human approved for a closer look. Nothing you do here launches or changes anything; your job is to find out whether the idea is viable.",
  "Your one required output is a feasibility report, submitted with report_submit. A clear, well-evidenced \"drop\" is a successful deep dive.",
  "Prefer primary sources: competitors' own pricing pages, official statistics, public filings, marketplace listings, search-volume data. Separate what you measured from what you estimated, and cite both.",
].join("\n");

const DEEP_DIVE_MAX_TURNS = 60;

/**
 * Set while a deep dive is executing, so the operator's abort button has something to cancel.
 * Aborting stops the model mid-run and skips reflect; a report already submitted stays.
 */
let deepDiveAbortController: AbortController | null = null;

/**
 * What the research phase claimed about the idea, restated for the deep dive as claims to check
 * rather than facts to build on. Empty for a legacy build-mode proposal, which is why this
 * returns lines to spread rather than a string.
 */
function researchClaims(proposal: ProposalRow): string[] {
  const monetization = parseMonetization(proposal);
  const market = parseMarket(proposal);
  const steps = parseSteps(proposal);
  const lines: string[] = [];

  if (market) {
    lines.push(
      [
        `The research phase's market read (viability ${market.viabilityScore}/5, ${market.confidence} confidence) -- verify or refute each claim:`,
        `  Market size: ${market.marketSize}`,
        ...market.demandEvidence.map((d) => `  Demand: ${d.claim} (${d.sourceUrl})`),
        ...market.competitors.map(
          (c) => `  Competitor: ${c.name}${c.url ? ` ${c.url}` : ""}${c.pricing ? ` -- ${c.pricing}` : ""}${c.gap ? `; gap: ${c.gap}` : ""}`
        ),
        ...market.keyRisks.map((r) => `  Risk: ${r}`),
      ].join("\n")
    );
  }
  if (monetization) {
    lines.push(
      `How it is supposed to make money (${proposal.revenue_model ?? "unspecified"}): ${monetization.whoPays} pays ${monetization.pricePoint}. Path to the first payment: ${monetization.pathToFirstDollar} (~${monetization.daysToFirstDollar} days). Key assumption: ${monetization.keyAssumption}.`
    );
  }
  if (steps.length > 0) {
    lines.push(`The proposed launch outline:\n${steps.map((s, i) => `  ${i + 1}. ${s.title} -- done when: ${s.doneWhen}`).join("\n")}`);
  }
  return lines;
}

/**
 * Investigates one approved idea, then checks that a report actually landed.
 *
 * The check matters for the same reason it did in build mode: `runAgent` returns whenever the
 * model stops calling tools, and a model that announces "now I'll write the report" and stops is
 * otherwise indistinguishable from one that wrote it. The nudge pushes back before the run is
 * allowed to end; the verdict records what happened if that didn't work.
 */
async function deepDivePhase(proposal: ProposalRow): Promise<{ verdict: DeepDiveVerdict; report: ReportRow | null }> {
  const readTools = availableReadTools();
  const allowedTools = [
    ...new Set([...MEMORY_TOOLS, ...READONLY_BUILTIN_TOOLS, ...readTools, ...DEEP_DIVE_OUTPUT_TOOLS]),
  ];
  const abortController = new AbortController();
  deepDiveAbortController = abortController;

  // Before the model is called, not after: anything between here and the verdict -- an abort,
  // a crash -- leaves the row saying `running`, which the next startup reaps into
  // `interrupted`. report_submit also reads it, to accept a report only for this idea.
  store.markActStarted(proposal.id);

  const goalTitle = (proposal.goal_id !== null ? store.getGoal(proposal.goal_id)?.title : undefined) ?? proposal.domain;
  const previous = store.listReportsForProposal(proposal.id)[0];
  const focus = proposal.human_notes?.trim();

  const result = await runPhase({
    nudge: ({ calls, stopReason }) => deepDiveNudge(calls, stopReason),
    phase: "act",
    proposalId: proposal.id,
    prompt: [
      `Investigate approved idea #${proposal.id} [${proposal.domain}]:\n${proposal.description}`,
      ...(proposal.original_description
        ? [`(The operator edited the description at approval. The model's original pitch was:\n${proposal.original_description})`]
        : []),
      ...(focus ? [`The operator's notes on approval -- questions your report must answer first:\n${focus}`] : []),
      ...researchClaims(proposal),
      ...(previous
        ? [
            `This idea was investigated before (report #${previous.id}, ${previous.created_at.slice(0, 10)}): ${previous.verdict}, ${previous.viability_score}/5. Its summary: ${previous.summary}\nUpdate that picture rather than repeating it, and say in the report what changed.`,
          ]
        : []),
      `Call lesson_search and research_note_search first, so you start from what is already known.`,
      `Use WebSearch/WebFetch${readTools.length > 0 ? ` and the read-only data tools (${readTools.map(unqualified).join(", ")})` : ""}. Save the important findings with research_note_add as you go, with \`kind\` set (competitor, pricing, demand, market_size, risk, gap, saturated) and \`domain\` set to exactly "${goalTitle}" -- they feed the operator's market view of that goal.`,
      `Then call report_submit with proposalId ${proposal.id}. The body is Markdown with these sections, in order: "## Summary", "## Market size", "## Competitors", "## Demand evidence", "## Pricing and unit economics", "## Risks", "## How a human would launch it" (the first 30 and 90 days, starting with the cheapest test that would validate demand), and "## Open questions". Cite sources inline as [text](url) and list them all in \`sources\`. No tables.`,
      `The verdict is yours to call: "pursue" if it is worth a human's time and money now, "maybe" if it is promising but hinges on open questions, "drop" if the evidence says it won't work.`,
    ].join("\n"),
    system: DEEP_DIVE_SYSTEM,
    allowedTools,
    maxTurns: DEEP_DIVE_MAX_TURNS,
    signal: abortController.signal,
  }).finally(() => {
    // Only clear if this run still owns the slot -- a later deep dive may have claimed it.
    if (deepDiveAbortController === abortController) deepDiveAbortController = null;
  });

  const verdict = verifyDeepDive({
    toolCalls: result.calls,
    stopReason: result.stopReason,
    providerStopReason: result.providerStopReason,
  });
  store.recordActVerdict(proposal.id, verdict);
  const latest = store.listReportsForProposal(proposal.id)[0];
  const report = latest && latest.id !== previous?.id ? latest : null;
  if (verdict.complete) return { verdict, report };

  console.warn(`[deep dive] idea #${proposal.id} did not complete:\n  - ${verdict.problems.join("\n  - ")}`);
  emitAgentEvent({
    type: "act_incomplete",
    proposalId: proposal.id,
    problems: verdict.problems,
    toolCalls: result.toolCalls,
    stopReason: result.stopReason,
    providerStopReason: result.providerStopReason,
  });
  return { verdict, report };
}

// ---- phase 4: reflect ---------------------------------------------------

async function reflectPhase(
  proposal: ProposalRow,
  { verdict, report }: { verdict: DeepDiveVerdict; report: ReportRow | null }
): Promise<void> {
  const researchScore = parseMarket(proposal)?.viabilityScore;
  const context = report
    ? [
        `The deep dive on idea #${proposal.id} in domain "${proposal.domain}" concluded: ${report.verdict}, viability ${report.viability_score}/5 (${report.confidence} confidence).`,
        `Its summary: ${report.summary}`,
        `The report, abridged:\n${preview(report.body, 1500)}`,
        ...(researchScore !== undefined
          ? [
              `The research phase had scored this idea ${researchScore}/5 before the deep dive. Did research over- or under-rate it, and what signal would have predicted the deep dive's verdict earlier? That calibration is worth a lesson.`,
            ]
          : []),
      ]
    : [
        `The deep dive on idea #${proposal.id} in domain "${proposal.domain}" did NOT produce a report. What went wrong:\n  - ${verdict.problems.join("\n  - ")}`,
        `Draw the lesson from that failure, not from an imagined finding.`,
      ];

  const result = await runPhase({
    // A turn that ends before `lesson_search` has run once isn't "nothing worth recording", it's
    // the phase never having looked -- proposal #30's reflect pass did exactly this, zero tool
    // calls in 3.3 seconds. This insists on the one call the prompt already requires; searching
    // and then deciding nothing more is needed still counts as done.
    nudge: ({ calls }) => {
      if (calls.some((c) => c.name === "mcp__memory__lesson_search")) return null;
      return [
        `Stop. You have not called lesson_search yet, and this reflect pass does not end until you have.`,
        `Call lesson_search for this domain now. If it turns up a lesson this deep dive confirmed or contradicted, call lesson_reinforce on it; otherwise call lesson_add exactly once.`,
      ].join("\n");
    },
    phase: "reflect",
    proposalId: proposal.id,
    prompt: [
      ...context,
      `Call lesson_search for this domain first. If an existing lesson was confirmed or contradicted by this deep dive, call lesson_reinforce on it instead of duplicating it.`,
      `Otherwise, call lesson_add exactly once with a generalized, reusable takeaway about this kind of market or idea -- not a retelling of this one report.`,
    ].join("\n"),
    system: REFLECT_SYSTEM,
    allowedTools: [...MEMORY_TOOLS],
    maxTurns: REFLECT_MAX_TURNS,
    signal: shutdownController.signal,
  });

  // The nudge above gives the model two chances to search before the phase is allowed to end;
  // if it still never did, that's the same "phase completed without doing its job" failure
  // research (`no_proposal`) and the deep dive (`act_incomplete`) both surface as an event.
  if (!result.calls.some((c) => c.name === "mcp__memory__lesson_search")) {
    console.warn(`[reflect] idea #${proposal.id} ended without ever calling lesson_search.`);
    emitAgentEvent({ type: "reflect_incomplete", proposalId: proposal.id, toolCalls: result.toolCalls });
  }
}

// ---- concurrency: parallel review, priority-ordered serialized deep dives --
//
// Deep dives run one at a time, which bounds spend and provider rate limits, and
// which approved idea goes next respects priority (then earliest due) rather than
// pure arrival order. An idea lands in runQueue either immediately on approval
// (humanReviewPhase, when it's due right now) or later via the scheduler tick
// (schedulerTick, for anything with a future scheduled_at or a recurring next_run_at).

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
  // immediately (a no-op) whenever the worker is already busy, so without this an idea
  // queued behind a running deep dive sat in `runQueue` for its whole run without ever
  // showing in `/api/queue`'s "queued" list.
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
  // Nothing new starts once a shutdown is under way: starting a deep dive we're about to abort
  // would only spend money on a run that cannot finish.
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
    const result = await deepDivePhase(next.proposal);
    // Reflect only after a deep dive that actually ran -- an aborted or failed one throws past
    // this. One that ran but submitted no report still reflects, and is told so.
    await reflectPhase(next.proposal, result);
  } catch (err) {
    // An abort is the operator stopping this deep dive, or the process shutting down -- both are
    // things they asked for, so neither is an error. The row stays `running` (markActStarted
    // wrote it before the model was called) and the next startup reaps it.
    if (isAbortError(err)) {
      console.log(`[deep dive] idea #${next.proposal.id} interrupted; it is marked interrupted on the next start.`);
    } else {
      console.error(`[deep dive] idea #${next.proposal.id} failed:`, err);
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
 * causes than one: a research phase aborted midway, a decision endpoint that raced a restart. Fixing only the notification would leave the rest.
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
        // Memory-only and short, so this doesn't go through the deep-dive queue.
        await reflectOnRejectionPhase(decided);
      }
    } catch (err) {
      // Same as the deep-dive queue: a shutdown mid-rejection-reflect is not a failure of this review.
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
 * no idea, report, action, lesson, note or run can change here.
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
  // Subscribed here rather than in server.ts because it is a property of the *loop* --
  // console-only mode blocks on nothing and has nothing to announce. Registered before the
  // first cycle so a proposal from that cycle is announced like any other.
  extraClosers.push(startNotifier());
  onRunNow(() => wakeCycle());
  onAbort((proposalId) => {
    if (deepDiveAbortController && runningProposalId === proposalId) {
      console.log(`[control] aborting the deep dive on idea #${proposalId}`);
      deepDiveAbortController.abort();
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

  // Record whatever the previous process left mid-flight, before the scheduler below gets a
  // look at it. An interrupted deep dive whose next_run_at survived resumes on the first tick;
  // see reapInterruptedDeepDives for why that is safe now.
  for (const stranded of store.reapInterruptedDeepDives()) {
    console.warn(`[deep dive] idea #${stranded.id} was mid-deep-dive when the previous process stopped; marked interrupted.`);
    emitAgentEvent({
      type: "act_incomplete",
      proposalId: stranded.id,
      problems: ["The deep dive was still running when the previous process stopped, so it never finished or reported."],
      toolCalls: 0,
      stopReason: "interrupted",
    });
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
        `${pendingCount} ideas already pending review (max ${getSetting("maxPendingProposals")}); skipping research this cycle.`
      );
    } else {
      const proposals = await researchAndPlanPhase();
      if (proposals.length > 0) {
        for (const p of proposals) enqueueForReview(p);
      } else {
        console.log("No new idea this cycle.");
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
/** Anything else to release on the way out: the second, narrow DB connection console-only
 * mode opens, and the notifier's subscription to the event bus. */
const extraClosers: (() => void)[] = [];

function installSignalHandlers(server?: { close(): unknown }): void {
  const shutdown = createShutdown({
    stopScheduler: () => {
      if (schedulerTimer) clearInterval(schedulerTimer);
    },
    closeServer: () => void server?.close(),
    // Both controllers: the shared one research and reflect listen on, and the deep dive's own
    // -- the same one the console's abort button fires, so a deep dive is only ever interrupted
    // through a path that already knows how to leave the record consistent.
    abortPhases: () => {
      shutdownController.abort();
      deepDiveAbortController?.abort();
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
