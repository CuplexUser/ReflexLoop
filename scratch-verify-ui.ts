// Scratch verification harness -- boots the real server.ts against a throwaway
// DB and seeds realistic data + live events, WITHOUT running the paid Claude
// agent loop. Only for visually/functionally checking the UI in a browser.
// Delete this file after verification.
import { MemoryStore } from "./src/memory-server.js";
import { startServer } from "./src/server.js";
import { emitAgentEvent } from "./src/events.js";
import { submitDecision } from "./src/review-gateway.js";
import { unlinkSync, existsSync } from "node:fs";
import * as http from "node:http";

const dbPath = "./data/verify-ui.db";
if (existsSync(dbPath)) unlinkSync(dbPath);
const store = new MemoryStore(dbPath);

const DOMAINS = [
  "micro-SaaS tool for developers (self-built and self-hosted)",
  "Chrome extension for developers",
  "VS Code extension for developers",
];

let newProposalId: number;

async function seed() {
  await store.addResearchNote(
    "dev tool pricing",
    "Most self-hosted dev tools succeed with a $9-19/mo tier and a generous free tier.",
    "https://example.com/pricing",
    0.8
  );
  await store.addResearchNote(
    "chrome extension distribution",
    "Chrome Web Store review can take 1-3 days for new extensions with host permissions.",
    "https://example.com/cws",
    0.6
  );

  const rejectedId = store.createProposal({
    domain: "Chrome extension for developers",
    description: "Build a tab-hoarder cleanup extension that groups and archives stale tabs.",
    expectedCost: 3,
    expectedTimeHours: 4,
    expectedUpside: 150,
    requiredTools: ["WebSearch", "WebFetch"],
  });
  store.decideProposal(rejectedId, "rejected", "Market is saturated with free alternatives already.");

  const approvedId = store.createProposal({
    domain: "micro-SaaS tool for developers (self-built and self-hosted)",
    description:
      "Ship a self-hosted uptime-check dashboard as a single Docker image, targeting indie devs who don't want a SaaS bill.",
    expectedCost: 4,
    expectedTimeHours: 5,
    expectedUpside: 300,
    requiredTools: ["WebSearch", "WebFetch", "mcp__integrations__github_create_repo"],
  });
  store.decideProposal(approvedId, "approved", "Good scope, try it.");
  const outcomeId = store.recordOutcome({
    proposalId: approvedId,
    actualRevenue: 0,
    actualCost: 3.2,
    actualTimeHours: 4.5,
    success: true,
    notes: "Repo scaffolded and published; too early for revenue signal.",
  });
  const lessonId = await store.addLesson(
    "micro-SaaS tool for developers (self-built and self-hosted)",
    "Self-hosted single-binary/Docker tools resonate more with this audience than hosted SaaS pitches.",
    outcomeId
  );
  store.reinforceLesson(lessonId, "confirmed");

  store.logRun(approvedId, "research_plan", 0.031, 42000, new Date(Date.now() - 3600_000).toISOString());
  store.logRun(approvedId, "act", 0.058, 61000, new Date(Date.now() - 1800_000).toISOString());
  store.logRun(approvedId, "reflect", 0.009, 8000, new Date(Date.now() - 900_000).toISOString());
}

function tick() {
  return new Promise((r) => setTimeout(r, 150));
}

async function main() {
  await seed();
  startServer(store, DOMAINS, 4055);
  emitAgentEvent({ type: "run_started", domains: DOMAINS });

  emitAgentEvent({ type: "phase_start", phase: "research_plan", proposalId: null });
  await tick();
  emitAgentEvent({
    type: "tool_call",
    phase: "research_plan",
    proposalId: null,
    toolName: "mcp__memory__lesson_search",
    input: { domain: "VS Code extension for developers" },
  });
  await tick();
  emitAgentEvent({
    type: "model_text",
    phase: "research_plan",
    proposalId: null,
    text: "Checking existing lessons before researching VS Code extension ideas for developers...",
  });
  await tick();
  emitAgentEvent({
    type: "tool_call",
    phase: "research_plan",
    proposalId: null,
    toolName: "WebSearch",
    input: { query: "VS Code extension ideas for developers 2026" },
  });
  await tick();
  emitAgentEvent({
    type: "tool_call",
    phase: "research_plan",
    proposalId: null,
    toolName: "mcp__integrations__github_search_repos",
    input: { query: "vscode extension boilerplate stars:>500" },
  });
  await tick();
  emitAgentEvent({
    type: "model_text",
    phase: "research_plan",
    proposalId: null,
    text: "Found a promising gap: a VS Code extension that surfaces flaky test history inline in the editor gutter.",
  });
  await tick();
  emitAgentEvent({ type: "phase_done", phase: "research_plan", proposalId: null, costUsd: 0.047, durationMs: 38000 });

  newProposalId = store.createProposal({
    domain: "VS Code extension for developers",
    description:
      "Build a VS Code extension that shows flaky-test history inline in the gutter, sourced from CI run history via a GitHub Actions API read.",
    expectedCost: 6,
    expectedTimeHours: 8,
    expectedUpside: 400,
    requiredTools: [
      "WebSearch",
      "mcp__integrations__github_read_repo",
      "mcp__integrations__github_create_repo",
      "mcp__integrations__github_commit_file",
    ],
  });
  const proposal = store.getProposal(newProposalId)!;
  emitAgentEvent({ type: "proposal_pending", proposal });

  // Tiny local control channel so this Bash tool call can trigger the
  // approve action later without needing a second orchestrator process.
  http
    .createServer((req, res) => {
      if (req.url === "/__approve") {
        submitDecision(newProposalId, { approved: true, notes: "looks solid, approved from verification script" });
        res.end("ok");
      } else {
        res.end("n/a");
      }
    })
    .listen(4056);

  console.log("SEEDED_AND_LISTENING", newProposalId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
