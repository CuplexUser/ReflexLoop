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
import type { MemoryStore, Priority } from "./memory-server.js";
import { emitAgentEvent, onAgentEvent, type AgentEvent } from "./events.js";
import { submitDecision, hasPendingDecision } from "./review-gateway.js";
import { fireReactiveTrigger } from "./reactive-triggers.js";
import { ALL_GRANTABLE_TOOLS, toolRisk } from "./tool-catalog.js";
import {
  getControlState,
  requestAbort,
  requestRunNow,
  setCycleIntervalMs,
  setDirective,
  setDomains,
  setPaused,
} from "./agent-control.js";

const API_TOKEN = process.env.AGENT_API_TOKEN ?? "";
const BIND_HOST = process.env.AGENT_BIND_HOST ?? "127.0.0.1";
const MIN_CYCLE_INTERVAL_MS = 60_000;

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

export function startServer(store: MemoryStore, port: number): Server {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

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

  // Tells the console whether it needs a token at all, without revealing it.
  app.get("/api/status", (_req, res) => {
    const control = getControlState();
    res.json({
      domains: control.domains,
      totalCostUsd: store.totalRunCost(),
      control,
      authRequired: Boolean(API_TOKEN),
    });
  });

  /** The tool catalog, so the console can badge which requested tools actually touch the world. */
  app.get("/api/tools", (_req, res) => {
    res.json(ALL_GRANTABLE_TOOLS.map((name) => ({ name, risk: toolRisk(name) })));
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

  app.post("/api/lessons/:id/mute", (req, res) => {
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
    store.setLessonMuted(id, muted);
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

  app.post("/api/control/domains", (req, res) => {
    const { domains } = req.body as { domains?: string[] };
    if (!Array.isArray(domains) || domains.length === 0 || domains.some((d) => typeof d !== "string" || !d.trim())) {
      res.status(400).json({ error: "Body must include a non-empty `domains` array of non-blank strings." });
      return;
    }
    setDomains(domains.map((d) => d.trim()));
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
    const { id, occurredAt } = store.logEvent(event.type, event);
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
