// src/server.ts
//
// REST + WebSocket API the web UI talks to. Runs inside the same process
// as the orchestrator (started from mainLoop) so it shares one SQLite
// connection -- no multi-process file locking, no polling files.
//
// REST: read history (proposals, outcomes, lessons, research, runs) and
// submit a review decision. WebSocket: live rebroadcast of AgentEvents as
// the agent works, so the UI updates without refreshing.

import express from "express";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { MemoryStore } from "./memory-server.js";
import { onAgentEvent, type AgentEvent } from "./events.js";
import { submitDecision, hasPendingDecision } from "./review-gateway.js";

export function startServer(store: MemoryStore, domains: string[], port: number): Server {
  const app = express();
  app.use(express.json());

  app.get("/api/status", (_req, res) => {
    res.json({ domains, totalCostUsd: store.totalRunCost() });
  });

  app.get("/api/proposals", (_req, res) => {
    res.json(store.listAllProposals());
  });

  app.get("/api/proposals/:id/actions", (req, res) => {
    res.json(store.listActions(Number(req.params.id)));
  });

  app.post("/api/proposals/:id/decision", (req, res) => {
    const id = Number(req.params.id);
    if (!hasPendingDecision(id)) {
      res.status(409).json({ error: "No pending decision for this proposal (already decided, or not up for review)." });
      return;
    }
    const { approved, notes } = req.body as { approved?: boolean; notes?: string };
    if (typeof approved !== "boolean") {
      res.status(400).json({ error: "Body must include boolean `approved`." });
      return;
    }
    submitDecision(id, { approved, notes });
    res.json({ ok: true });
  });

  app.get("/api/outcomes", (_req, res) => {
    res.json(store.listOutcomes());
  });

  app.get("/api/lessons", (_req, res) => {
    res.json(store.listAllLessons());
  });

  app.get("/api/research-notes", (_req, res) => {
    res.json(store.listAllResearchNotes());
  });

  app.get("/api/runs", (_req, res) => {
    res.json(store.listRuns());
  });

  // Serve the built frontend, if present (npm run build in web/). In dev,
  // the Vite dev server (with a proxy to this port) serves the UI instead.
  const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(distDir, "index.html")));
  }

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  onAgentEvent((event: AgentEvent) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  });

  httpServer.listen(port, () => {
    console.log(`[server] agent-runner UI listening on http://localhost:${port}`);
  });

  return httpServer;
}
