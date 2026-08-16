// src/server.ts
//
// REST + WebSocket API the web UI talks to. Runs inside the same process
// as the orchestrator (started from mainLoop) so it shares one SQLite
// connection -- no multi-process file locking, no polling files.
//
// REST: read history (proposals, outcomes, lessons, research, runs), curate
// the agent's memory, drive runtime controls, and submit review decisions.
// WebSocket: live rebroadcast of AgentEvents as the agent works, so the UI
// updates without refreshing.
//
// Auth: everything under /api and the WebSocket upgrade sit behind a shared
// token when AGENT_API_TOKEN is set. It's a single shared secret, not real
// user auth -- enough to stop a device on the same network from approving a
// side-effecting proposal, not enough to expose this to the internet. The
// bind address defaults to loopback for the same reason.

import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { goalTitleFromDomain, type GoalStatus, type MemoryStore, type Priority } from "./memory-server.js";
import { emitAgentEvent, onAgentEvent, type AgentEvent } from "./events.js";
import { submitDecision, hasPendingDecision } from "./review-gateway.js";
import { fireReactiveTrigger } from "./reactive-triggers.js";
import { ALL_GRANTABLE_TOOLS, toolRisk } from "./tool-catalog.js";
import { configuredConnectorTools, connectorOperation, connectorStatus } from "./connectors/load.js";
import { listSettings, updateSettings } from "./settings.js";
import { PROVIDERS, PROVIDER_IDS, resolveLlmClients } from "./llm/index.js";
import { getSearchConfig } from "./search/index.js";
import { buildDeliverables, type DeliverableOutcomeRow } from "./deliverables.js";
import { isConsoleOnlyMode } from "./console-mode.js";
import { CONSOLE_ONLY_WRITABLE_ROUTES, type ControlSettingsWriter } from "./control-settings-writer.js";
import {
  getControlState,
  requestAbort,
  requestRunNow,
  setCycleIntervalMs,
  setDirective,
  setGoals,
  setPaused,
} from "./agent-control.js";

const API_TOKEN = process.env.AGENT_API_TOKEN ?? "";
const BIND_HOST = process.env.AGENT_BIND_HOST ?? "127.0.0.1";
const MIN_CYCLE_INTERVAL_MS = 60_000;
const GOAL_STATUSES: string[] = ["active", "paused", "retired", "suggested"];

/** Constant-time compare so a wrong token can't be recovered by timing the response. */
function tokenMatches(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(API_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedToken(req: { headers: Record<string, unknown>; url?: string }): string {
  const header = req.headers["authorization"];
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7);
  // The browser WebSocket API can't set headers, so the socket passes the token as a
  // query parameter instead. Same secret, same check.
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    return url.searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

/**
 * `settingsWriter` is present only in console-only mode, where the store is read-only and every
 * write that mode still allows has to go through that narrow connection instead. Its absence is
 * what tells the goal routes below they're in a normal run and may use the store directly.
 */
export function startServer(
  store: MemoryStore,
  port: number,
  opts: { settingsWriter?: ControlSettingsWriter } = {}
): Server {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  /**
   * Re-reads goals from the DB into control state after any mutation. A full re-read rather than
   * patching the in-memory copy: the table is the source of truth, and re-reading it is the one
   * update that cannot disagree with it.
   */
  const refreshGoals = () => setGoals(store.listGoals().map((g) => ({
    id: g.id,
    title: g.title,
    brief: g.brief,
    status: g.status,
    weight: g.weight,
  })));

  if (API_TOKEN) {
    app.use("/api", (req: Request, res: Response, next: NextFunction) => {
      if (tokenMatches(presentedToken(req as never))) return next();
      res.status(401).json({ error: "Missing or invalid API token." });
    });
  } else {
    console.warn(
      "[server] AGENT_API_TOKEN is not set -- the console's API is unauthenticated. " +
        `Bound to ${BIND_HOST}; set a token before binding anywhere else.`
    );
  }

  // Console-only mode (--console-only, see console-mode.ts) is read-only apart from three
  // operator settings. The store is opened read-only, so anything else would surface as a
  // SQLite error from somewhere deep; refusing it here instead means the UI gets one clear
  // answer, and the refusal is enforced at the entrance rather than discovered at the exit.
  //
  // The allowlist is routes, not a general "control endpoints are fine": run-now and abort
  // are control endpoints too, and both would answer 200 while doing nothing at all in this
  // mode (no loop is sleeping for run-now to wake, and no act phase is running to abort).
  // A button that reports success and has no effect is worse than one that refuses. The
  // writer behind these routes enforces the same narrow vocabulary independently -- see
  // control-settings-writer.ts.
  //
  // PATCH is allowed alongside POST because editing a goal is a PATCH; the allowlist still
  // decides which paths, so this widens the verbs the list is consulted for, not the list.
  if (isConsoleOnlyMode()) {
    app.use("/api", (req: Request, res: Response, next: NextFunction) => {
      if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
      const path = req.path.replace(/\/+$/, "");
      const writableMethod = req.method === "POST" || req.method === "PATCH";
      if (writableMethod && CONSOLE_ONLY_WRITABLE_ROUTES.some((route) => route.test(path))) return next();
      res.status(403).json({
        error:
          "Read-only console mode (--console-only): only goals and the cycle interval and pause settings can be changed here.",
      });
    });
  }

  // Tells the console whether it needs a token at all, without revealing it.
  app.get("/api/status", (_req, res) => {
    const control = getControlState();
    res.json({
      domains: control.domains,
      totalCostUsd: store.totalRunCost(),
      control,
      authRequired: Boolean(API_TOKEN),
      // So the UI can disable what this instance would refuse, instead of offering every
      // write button and letting each one fail with a 403 toast once clicked.
      consoleOnly: isConsoleOnlyMode(),
    });
  });

  /**
   * The tool catalog, so the console can badge which requested tools actually touch the world.
   *
   * `configured` is only ever false for a connector whose credential is missing. It's here
   * because that's a fact the operator needs at decision time -- approving a proposal fenced
   * to a tool with no key behind it produces an act phase that can only fail -- and the
   * catalog is where the console already looks.
   */
  app.get("/api/tools", (_req, res) => {
    const configured = new Set(configuredConnectorTools());
    res.json(
      ALL_GRANTABLE_TOOLS.map((name) => ({
        name,
        risk: toolRisk(name),
        configured: !connectorOperation(name) || configured.has(name),
      }))
    );
  });

  /** Which connectors exist and which are still missing a key, for the Agent control page. */
  app.get("/api/connectors", (_req, res) => {
    res.json(connectorStatus());
  });

  /**
   * Operator settings, plus the two things the console can't work out for itself: which
   * providers actually have a key in `.env`, and which search backends do. Without those the
   * page would happily offer a provider whose key is missing, and the failure would surface an
   * hour later on the next cycle instead of at the click.
   */
  app.get("/api/settings", (_req, res) => {
    res.json({
      settings: listSettings(),
      providers: PROVIDER_IDS.map((id) => ({
        id,
        label: PROVIDERS[id].label,
        hasKey: Boolean((process.env[PROVIDERS[id].apiKeyEnv] ?? "").trim()),
        apiKeyEnv: PROVIDERS[id].apiKeyEnv,
        modelsUrl: PROVIDERS[id].modelsUrl,
      })),
      searchKeys: {
        tavily: Boolean((process.env.TAVILY_API_KEY ?? "").trim()),
        brave: Boolean((process.env.BRAVE_API_KEY ?? "").trim()),
      },
    });
  });

  /**
   * Saves a settings patch, or none of it.
   *
   * The `verify` callback is the guard that field validation can't provide: it re-resolves the
   * LLM clients and the search config against the *already-applied* values, so a provider with
   * no key, a model that resolves to nothing, or a search mode missing its key is rejected here
   * -- with the message the startup check used to give -- rather than being saved and failing
   * on the next cycle. `updateSettings` rolls back if it throws.
   */
  app.post("/api/settings", (req, res) => {
    const patch = req.body as Record<string, unknown> | undefined;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return res.status(400).json({ error: "Body must be an object of setting keys." });
    }

    // Scoped to what the patch actually touches. Verifying everything on every save would let
    // an unrelated misconfiguration (no AGENT_MODEL yet) block an unrelated valid edit -- and
    // that is the normal state of a fresh install, where the first thing you'd do is set the
    // model from this very page. It also means console-only mode gets the model check rather
    // than skipping it: resolveLlmClients() is a pure function of settings plus the API keys in
    // .env, so it needs no running loop, and that mode is exactly where the next run's model
    // gets configured.
    const touched = Object.keys(patch);
    const touchesModel = touched.some((k) => /model|provider/i.test(k));
    const touchesSearch = touched.includes("searchProvider");

    const { error } = updateSettings(patch, () => {
      if (touchesModel) resolveLlmClients();
      if (touchesSearch) getSearchConfig();
      return null;
    });
    if (error) return res.status(400).json({ error });

    res.json({ ok: true, settings: listSettings() });
  });

  app.get("/api/proposals", (_req, res) => {
    res.json(store.listAllProposals());
  });

  app.get("/api/proposals/:id/actions", (req, res) => {
    res.json(store.listActions(Number(req.params.id)));
  });

  app.get("/api/proposals/:id/runs", (req, res) => {
    res.json(store.listRunsForProposal(Number(req.params.id)));
  });

  const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];
  const MIN_RECURRENCE_MS = 5 * 60 * 1000; // 5 minutes -- blocks a fat-fingered tight loop

  interface DecisionBody {
    approved?: boolean;
    notes?: string;
    priority?: Priority;
    scheduledAt?: string | null;
    recurrenceMs?: number | null;
    editedDescription?: string;
    editedRequiredTools?: string[];
  }

  /** Shared by the single and bulk decision endpoints. Returns an error string, or null if valid. */
  function validateDecision(body: DecisionBody): string | null {
    if (typeof body.approved !== "boolean") return "Body must include boolean `approved`.";
    if (body.priority !== undefined && !PRIORITIES.includes(body.priority)) {
      return `\`priority\` must be one of: ${PRIORITIES.join(", ")}.`;
    }
    if (body.scheduledAt != null && Number.isNaN(new Date(body.scheduledAt).getTime())) {
      return "`scheduledAt` must be a valid date string.";
    }
    if (body.recurrenceMs != null && (!Number.isFinite(body.recurrenceMs) || body.recurrenceMs < MIN_RECURRENCE_MS)) {
      return `\`recurrenceMs\` must be at least ${MIN_RECURRENCE_MS}ms (5 minutes).`;
    }
    if (body.editedRequiredTools !== undefined) {
      if (
        !Array.isArray(body.editedRequiredTools) ||
        body.editedRequiredTools.some((t) => typeof t !== "string" || !t.trim())
      ) {
        return "`editedRequiredTools` must be an array of non-blank tool names.";
      }
      // A name outside the catalog is allowed through rather than rejected. It cannot
      // grant anything -- agent-loop.ts dispatches by exact name, so an unrecognized
      // entry simply never matches a tool -- and refusing it blocked legitimate cases
      // (a catalog fetched before a tool was added, an operator who knows the name).
      // The console badges it as unknown; this logs it so the same surprise is visible
      // to anyone tailing stdout rather than watching the UI.
      const unknown = body.editedRequiredTools.filter((t) => !ALL_GRANTABLE_TOOLS.includes(t.trim()));
      if (unknown.length > 0) {
        console.warn(`[server] approved required_tools include names not in the catalog: ${unknown.join(", ")}`);
      }
    }
    if (body.editedDescription !== undefined && typeof body.editedDescription !== "string") {
      return "`editedDescription` must be a string.";
    }
    return null;
  }

  app.post("/api/proposals/:id/decision", (req, res) => {
    const id = Number(req.params.id);
    if (!hasPendingDecision(id)) {
      res.status(409).json({ error: "No pending decision for this proposal (already decided, or not up for review)." });
      return;
    }
    const body = req.body as DecisionBody;
    const error = validateDecision(body);
    if (error) {
      res.status(400).json({ error });
      return;
    }
    submitDecision(id, { ...body, approved: body.approved! });
    res.json({ ok: true });
  });

  /** Approve or reject several pending proposals at once -- same validation, applied per id. */
  app.post("/api/proposals/bulk-decision", (req, res) => {
    const { ids, ...rest } = req.body as DecisionBody & { ids?: number[] };
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !Number.isInteger(id))) {
      res.status(400).json({ error: "Body must include a non-empty `ids` array of proposal ids." });
      return;
    }
    const error = validateDecision(rest);
    if (error) {
      res.status(400).json({ error });
      return;
    }
    // Scope edits are per-proposal by nature, so they're not accepted in bulk.
    const decided: number[] = [];
    const skipped: number[] = [];
    for (const id of ids) {
      if (!hasPendingDecision(id)) {
        skipped.push(id);
        continue;
      }
      submitDecision(id, { approved: rest.approved!, notes: rest.notes, priority: rest.priority });
      decided.push(id);
    }
    res.json({ ok: true, decided, skipped });
  });

  /**
   * Edit an approved proposal's scope before it runs.
   *
   * Approving used to be the only moment scope was editable, which made a scheduled or
   * queued proposal un-narrowable: the operator could see it was about to do something
   * slightly wrong and their only lever was cancelling the schedule. This reopens that
   * window for exactly as long as it's meaningful -- until an act phase has actually
   * started. After that, narrowing can't un-commit anything and widening would authorise
   * work retroactively, so it stays closed.
   *
   * Pending proposals don't come through here: their scope travels with the approval
   * decision (POST /decision), which applies edits before the status flips so a proposal
   * is never approved while still carrying its pre-edit fence.
   */
  app.post("/api/proposals/:id/scope", (req, res) => {
    const id = Number(req.params.id);
    const proposal = store.getProposal(id);
    if (!proposal) {
      res.status(404).json({ error: "No such proposal." });
      return;
    }
    if (proposal.status !== "approved") {
      res.status(409).json({
        error:
          proposal.status === "pending"
            ? "Edit a pending proposal's scope as part of approving it, not here."
            : `Cannot edit scope on a ${proposal.status} proposal.`,
      });
      return;
    }
    if (getControlState().runningProposalId === id) {
      res.status(409).json({ error: "This proposal's act phase is running; abort it first." });
      return;
    }
    if (store.hasActed(id)) {
      res.status(409).json({ error: "This proposal has already acted; its scope can no longer be changed." });
      return;
    }

    const { description, requiredTools } = req.body as { description?: string; requiredTools?: string[] };
    if (description === undefined && requiredTools === undefined) {
      res.status(400).json({ error: "Body must include `description` and/or `requiredTools`." });
      return;
    }
    if (description !== undefined && (typeof description !== "string" || !description.trim())) {
      res.status(400).json({ error: "`description` must be a non-blank string." });
      return;
    }
    if (
      requiredTools !== undefined &&
      (!Array.isArray(requiredTools) || requiredTools.some((t) => typeof t !== "string" || !t.trim()))
    ) {
      res.status(400).json({ error: "`requiredTools` must be an array of non-blank tool names." });
      return;
    }
    if (requiredTools) {
      // Same rule as at approval time: an uncatalogued name is allowed but noted, since
      // it can't grant anything the loop will actually dispatch.
      const unknown = requiredTools.filter((t) => !ALL_GRANTABLE_TOOLS.includes(t.trim()));
      if (unknown.length > 0) {
        console.warn(`[server] proposal #${id} scope edited to include uncatalogued tools: ${unknown.join(", ")}`);
      }
    }

    store.applyProposalEdits(id, { description, requiredTools });
    const updated = store.getProposal(id)!;
    // Same event the approval path emits, so the console's tables and any open dialog
    // refresh through the existing historyVersion path rather than needing a new one.
    emitAgentEvent({ type: "proposal_decided", proposal: updated });
    res.json({ ok: true, proposal: updated });
  });

  app.post("/api/proposals/:id/cancel-schedule", (req, res) => {
    const id = Number(req.params.id);
    if (!store.getProposal(id)) {
      res.status(404).json({ error: "No such proposal." });
      return;
    }
    store.cancelSchedule(id);
    res.json({ ok: true });
  });

  /**
   * Put an approved proposal back in the run queue.
   *
   * The manual half of `reapAfterUncleanShutdown`: a proposal whose act phase was interrupted
   * or didn't finish is descheduled at startup rather than silently re-run, because re-running
   * repeats real side effects. This is how it resumes, once a human has looked at what the
   * previous attempt actually left behind. It only re-triggers already-approved work -- the
   * approval itself is untouched, so this grants nothing.
   *
   * Not in CONSOLE_ONLY_WRITABLE_ROUTES on purpose, same reason as run-now: it needs a running
   * loop, and answering 200 while nothing is listening is worse than refusing.
   */
  app.post("/api/proposals/:id/rerun", (req, res) => {
    const id = Number(req.params.id);
    const proposal = store.getProposal(id);
    if (!proposal) {
      res.status(404).json({ error: "No such proposal." });
      return;
    }
    if (proposal.act_status === "running") {
      res.status(409).json({ error: `Proposal #${id} is executing right now -- wait for it to finish, or abort it first.` });
      return;
    }
    if (!store.requeueApprovedProposal(id)) {
      res.status(409).json({ error: `Proposal #${id} is ${proposal.status}, not approved -- only approved work can be re-run.` });
      return;
    }
    const requeued = store.getProposal(id)!;
    // Announced so the console reflects it: this is the event that says "this proposal has a run
    // due", the same one a future-dated approval emits, and it's in the set that invalidates the
    // REST caches -- without it the button would work and the page would look unchanged.
    emitAgentEvent({ type: "proposal_scheduled", proposal: requeued });
    res.json({ ok: true, proposal: requeued });
  });

  app.post("/api/proposals/:id/review", (req, res) => {
    const id = Number(req.params.id);
    const { reviewStatus } = req.body as { reviewStatus?: "mvp_done" | "needs_refinement" | null };
    if (reviewStatus !== null && reviewStatus !== "mvp_done" && reviewStatus !== "needs_refinement") {
      res.status(400).json({ error: "Body must include `reviewStatus`: 'mvp_done', 'needs_refinement', or null." });
      return;
    }
    if (!store.getProposal(id)) {
      res.status(404).json({ error: "No such proposal." });
      return;
    }
    store.setProposalReview(id, reviewStatus);
    if (reviewStatus === "needs_refinement") {
      fireReactiveTrigger({ proposalId: id, reason: "needs_refinement" });
    }
    res.json({ ok: true });
  });

  app.get("/api/outcomes", (_req, res) => {
    res.json(store.listOutcomes());
  });

  // ---- memory curation (human-only; the model has no tool for any of this) ----

  app.get("/api/lessons", (_req, res) => {
    res.json(store.listAllLessons());
  });

  app.patch("/api/lessons/:id", (req, res) => {
    const id = Number(req.params.id);
    const { domain, lesson } = req.body as { domain?: string; lesson?: string };
    if (domain === undefined && lesson === undefined) {
      res.status(400).json({ error: "Body must include `domain` and/or `lesson`." });
      return;
    }
    if ((domain !== undefined && !domain.trim()) || (lesson !== undefined && !lesson.trim())) {
      res.status(400).json({ error: "`domain` and `lesson` cannot be blank." });
      return;
    }
    void store.editLesson(id, { domain, lesson }).then((ok) => {
      if (!ok) res.status(404).json({ error: "No such lesson." });
      else res.json({ ok: true });
    });
  });

  app.post("/api/lessons/:id/mute", async (req, res) => {
    const id = Number(req.params.id);
    const { muted } = req.body as { muted?: boolean };
    if (typeof muted !== "boolean") {
      res.status(400).json({ error: "Body must include boolean `muted`." });
      return;
    }
    if (!store.getLesson(id)) {
      res.status(404).json({ error: "No such lesson." });
      return;
    }
    // Awaited: muting now also clears the flag on the Qdrant point that lesson_search filters
    // on, so answering before that lands would report success while the lesson was still
    // reachable by the agent.
    await store.setLessonMuted(id, muted);
    res.json({ ok: true });
  });

  app.delete("/api/lessons/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!store.getLesson(id)) {
      res.status(404).json({ error: "No such lesson." });
      return;
    }
    void store.deleteLesson(id).then(() => res.json({ ok: true }));
  });

  app.get("/api/research-notes", (_req, res) => {
    res.json(store.listAllResearchNotes());
  });

  app.get("/api/research-notes/duplicates", (req, res) => {
    const threshold = Number(req.query.threshold ?? 0.6);
    res.json(store.findDuplicateResearchNotes(Number.isFinite(threshold) ? threshold : 0.6));
  });

  app.post("/api/research-notes/merge", (req, res) => {
    const { keepId, mergeIds } = req.body as { keepId?: number; mergeIds?: number[] };
    if (!Number.isInteger(keepId) || !Array.isArray(mergeIds) || mergeIds.some((id) => !Number.isInteger(id))) {
      res.status(400).json({ error: "Body must include integer `keepId` and an array of integer `mergeIds`." });
      return;
    }
    void store.mergeResearchNotes(keepId!, mergeIds).then((ok) => {
      if (!ok) res.status(404).json({ error: "No such note." });
      else res.json({ ok: true });
    });
  });

  app.delete("/api/research-notes/:id", (req, res) => {
    void store.deleteResearchNote(Number(req.params.id)).then(() => res.json({ ok: true }));
  });

  // ---- search + economics ---------------------------------------------------

  app.get("/api/search", (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      res.json([]);
      return;
    }
    void store
      .searchEverything(q)
      .then((hits) => res.json(hits))
      .catch(() => res.status(500).json({ error: "Search failed." }));
  });

  app.get("/api/economics", (_req, res) => {
    res.json({
      spendByPhase: store.spendByPhase(),
      spendByModel: store.spendByModel(),
      spendOverTime: store.spendOverTime(),
      domains: store.domainScoreboard(),
      totalCostUsd: store.totalRunCost(),
      // Sent alongside the total so the console can account for the whole of it: the domain
      // scoreboard only sees spend charged to a proposal, and research/plan runs never are.
      unattributedSpend: store.unattributedSpend(),
    });
  });

  app.get("/api/runs", (_req, res) => {
    res.json(store.listRuns());
  });

  app.get("/api/events", (_req, res) => {
    res.json(store.listRecentEvents());
  });

  app.get("/api/actions", (_req, res) => {
    res.json(store.listActionsForApprovedProposals());
  });

  /**
   * What the agent has actually built, one record per approved proposal that produced
   * something reachable. Derived on read from the same action rows the Actions page
   * shows -- no separate state to keep in step -- but the heavy JSON (committed file
   * contents, fetched pages) is parsed here and never crosses the wire.
   */
  app.get("/api/deliverables", (_req, res) => {
    res.json(
      buildDeliverables(
        store.listDeliverableActions(),
        store.listAllProposals(),
        store.listOutcomes() as unknown as DeliverableOutcomeRow[],
        store.actActionCounts()
      )
    );
  });

  // ---- runtime control ------------------------------------------------------
  //
  // Everything here either reduces what the agent does (pause, abort) or changes
  // what it researches (domains, directive, interval). None of it can approve a
  // proposal or widen the act-phase fence -- those stay with the review flow.

  app.get("/api/control", (_req, res) => {
    res.json(getControlState());
  });

  app.post("/api/control/pause", (req, res) => {
    const { paused } = req.body as { paused?: boolean };
    if (typeof paused !== "boolean") {
      res.status(400).json({ error: "Body must include boolean `paused`." });
      return;
    }
    setPaused(paused);
    res.json({ ok: true, control: getControlState() });
  });

  app.post("/api/control/run-now", (_req, res) => {
    if (getControlState().paused) {
      res.status(409).json({ error: "Loop is paused -- resume before requesting a cycle." });
      return;
    }
    requestRunNow();
    res.json({ ok: true });
  });

  app.post("/api/control/abort", (req, res) => {
    const { proposalId } = req.body as { proposalId?: number };
    const running = getControlState().runningProposalId;
    if (running === null) {
      res.status(409).json({ error: "No act phase is currently running." });
      return;
    }
    if (proposalId !== undefined && proposalId !== running) {
      res.status(409).json({ error: `Proposal #${proposalId} is not the one currently running (#${running}).` });
      return;
    }
    requestAbort(running);
    res.json({ ok: true });
  });

  // ---- goals ---------------------------------------------------------------
  //
  // Every write here is the operator's. `goal_suggest` is the only thing the model can do to
  // this table, and all it can produce is a row with status='suggested' that the loop never
  // reads -- accepting one is a human clicking accept, below.

  app.get("/api/goals", (_req, res) => {
    res.json({ goals: store.listGoals(), health: store.goalHealth() });
  });

  app.post("/api/goals", (req, res) => {
    const { title, brief, weight } = req.body as { title?: string; brief?: string; weight?: number };
    if (typeof title !== "string" || !title.trim()) {
      res.status(400).json({ error: "Body must include a non-blank `title`." });
      return;
    }
    const fields = { title: title.trim(), brief: typeof brief === "string" ? brief : "", weight: weight ?? 1 };
    const id = opts.settingsWriter ? opts.settingsWriter.createGoal(fields) : store.createGoal(fields);
    refreshGoals();
    res.json({ ok: true, id, control: getControlState() });
  });

  app.patch("/api/goals/:id", (req, res) => {
    const id = Number(req.params.id);
    const { title, brief, status, weight, parentId } = req.body as {
      title?: string;
      brief?: string;
      status?: string;
      weight?: number;
      parentId?: number | null;
    };
    if ((title !== undefined && !title.trim()) || (status !== undefined && !GOAL_STATUSES.includes(status))) {
      res.status(400).json({ error: `\`title\` must be non-blank and \`status\` one of: ${GOAL_STATUSES.join(", ")}.` });
      return;
    }

    const ok = opts.settingsWriter
      ? opts.settingsWriter.updateGoal(id, { title: title?.trim(), brief, status, weight, parent_id: parentId })
      : store.updateGoal(id, { title: title?.trim(), brief, status: status as GoalStatus | undefined, weight, parentId });
    if (!ok) {
      res.status(404).json({ error: `No goal #${id}, or nothing to change.` });
      return;
    }
    refreshGoals();
    res.json({ ok: true, control: getControlState() });
  });

  /** Accept a suggested goal: the one step that turns the agent's pointer into a lane it works on. */
  app.post("/api/goals/:id/accept", (req, res) => {
    const id = Number(req.params.id);
    const { title, brief } = req.body as { title?: string; brief?: string };
    // Edits are applied in the same call as the status flip, for the same reason approve-with-
    // edits is one call on proposals: a goal must never be briefly active carrying text the
    // operator was in the middle of correcting.
    const patch = { title: title?.trim(), brief, status: "active" as const };
    const ok = opts.settingsWriter ? opts.settingsWriter.updateGoal(id, patch) : store.updateGoal(id, patch);
    if (!ok) {
      res.status(404).json({ error: `No goal #${id}.` });
      return;
    }
    refreshGoals();
    res.json({ ok: true, control: getControlState() });
  });

  /** Dismiss: retire rather than delete, so a re-suggestion of the same lane is still refused. */
  app.post("/api/goals/:id/dismiss", (req, res) => {
    const id = Number(req.params.id);
    const patch = { status: "retired" as const };
    const ok = opts.settingsWriter ? opts.settingsWriter.updateGoal(id, patch) : store.updateGoal(id, patch);
    if (!ok) {
      res.status(404).json({ error: `No goal #${id}.` });
      return;
    }
    refreshGoals();
    res.json({ ok: true, control: getControlState() });
  });

  app.delete("/api/goals/:id", (req, res) => {
    if (!store.deleteGoal(Number(req.params.id))) {
      res.status(404).json({ error: `No goal #${req.params.id}.` });
      return;
    }
    refreshGoals();
    res.json({ ok: true, control: getControlState() });
  });

  /**
   * Kept for back-compat with the old newline-textarea console and anything scripted against it.
   * Reconciles the active goal set to exactly the titles given: matching titles stay (keeping
   * their briefs, health and id), missing ones are retired rather than deleted, and new ones are
   * created. Retiring rather than deleting matters -- deleting would orphan the work filed under
   * a lane just because it fell out of a list someone retyped.
   */
  app.post("/api/control/domains", (req, res) => {
    const { domains } = req.body as { domains?: string[] };
    if (!Array.isArray(domains) || domains.length === 0 || domains.some((d) => typeof d !== "string" || !d.trim())) {
      res.status(400).json({ error: "Body must include a non-empty `domains` array of non-blank strings." });
      return;
    }
    if (opts.settingsWriter) {
      res.status(409).json({ error: "Edit goals directly in this mode -- POST /api/goals and PATCH /api/goals/:id." });
      return;
    }

    const wanted = domains.map((d) => d.trim());
    const existing = store.listGoals();
    for (const goal of existing) {
      const stillWanted = wanted.some((w) => w.toLowerCase() === goal.title.toLowerCase());
      if (goal.status === "active" && !stillWanted) store.updateGoal(goal.id, { status: "retired" });
      if (stillWanted && goal.status !== "active") store.updateGoal(goal.id, { status: "active" });
    }
    for (const title of wanted) {
      if (!existing.some((g) => g.title.toLowerCase() === title.toLowerCase())) {
        store.createGoal({ title: goalTitleFromDomain(title), brief: title });
      }
    }
    refreshGoals();
    res.json({ ok: true, control: getControlState() });
  });

  app.post("/api/control/interval", (req, res) => {
    const { cycleIntervalMs } = req.body as { cycleIntervalMs?: number };
    if (!Number.isFinite(cycleIntervalMs) || cycleIntervalMs! < MIN_CYCLE_INTERVAL_MS) {
      res.status(400).json({ error: `\`cycleIntervalMs\` must be at least ${MIN_CYCLE_INTERVAL_MS}ms (1 minute).` });
      return;
    }
    setCycleIntervalMs(cycleIntervalMs!);
    res.json({ ok: true, control: getControlState() });
  });

  app.post("/api/control/directive", (req, res) => {
    const { directive } = req.body as { directive?: string | null };
    if (directive !== null && typeof directive !== "string") {
      res.status(400).json({ error: "`directive` must be a string, or null to clear it." });
      return;
    }
    setDirective(directive === null || !directive.trim() ? null : directive.trim());
    res.json({ ok: true, control: getControlState() });
  });

  // An /api path that matched nothing above is a 404, and has to say so *before* the SPA
  // fallback below sees it -- otherwise an unknown endpoint answers 200 with index.html,
  // the console's fetch fails on parsing HTML as JSON, and the page renders as though the
  // server had legitimately returned nothing. That is exactly how a console running ahead
  // of a not-yet-restarted backend presents itself: an empty page with no error anywhere.
  app.use("/api", (req: Request, res: Response) => {
    res.status(404).json({ error: `No such endpoint: ${req.method} /api${req.path}` });
  });

  // Serve the built frontend, if present (npm run build in web/). In dev,
  // the Vite dev server (with a proxy to this port) serves the UI instead.
  const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(distDir, "index.html")));
  }

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // Same token check as /api, applied at the upgrade so an unauthenticated socket
  // never gets to see the event stream.
  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "", "http://localhost");
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (API_TOKEN && !tokenMatches(presentedToken(req as never))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  onAgentEvent((event: AgentEvent) => {
    // Persisting is a write, so in read-only console mode the event is broadcast live and
    // not stored. Nothing emits in that mode today (no loop, no write endpoints); this is
    // here so that if something ever does, it can't take the server down.
    const { id, occurredAt } = isConsoleOnlyMode()
      ? { id: -Date.now(), occurredAt: new Date().toISOString() }
      : store.logEvent(event.type, event);
    const payload = JSON.stringify({ id, occurredAt, event });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  });

  httpServer.listen(port, BIND_HOST, () => {
    console.log(`[server] agent-runner UI listening on http://${BIND_HOST}:${port}`);
  });

  return httpServer;
}
