import "dotenv/config";
import { buildIntegrationsTools } from "./integrations-server.js";
import { buildConnectorTools } from "./connectors/tools.js";
import { CONNECTOR_ERRORS } from "./connectors/load.js";
import { buildWebTools } from "./tools/web.js";
import { ToolRegistry } from "./tools/registry.js";
import { ALL_CATALOG_TOOLS, toolRisk } from "./tool-catalog.js";
import { unlinkSync, existsSync } from "node:fs";

// Qdrant is disabled for this run, and it has to happen before memory-server is loaded --
// hence the dynamic import below, since static imports are hoisted above ordinary statements.
//
// The database here is a throwaway, but a Qdrant cluster is not: point ids are SQLite rowids,
// so a smoke test writing note #1 and lesson #1 overwrites the real note #1 and lesson #1 in the
// shared collections. Running the smoke test would quietly corrupt the agent's actual memory.
// With these unset, qdrant.ts reports itself unavailable and every call short-circuits, which
// also means this exercises the LIKE-fallback path -- the one that has to work without a cluster.
for (const key of ["QDRANT_URL", "QDRANT_API_KEY", "QDRANT_EMBEDDING_MODEL", "QDRANT_EMBEDDING_DIM"]) {
  delete process.env[key];
}
const { MemoryStore, buildMemoryTools } = await import("./memory-server.js");

const dbPath = "./data/smoke-test.db";
if (existsSync(dbPath)) unlinkSync(dbPath);

const store = new MemoryStore(dbPath);

// Builds the same registry orchestrator.ts does, then converts every schema to the
// JSON Schema the wire needs. This is the cheap way to catch a zod shape that can't be
// serialized -- otherwise the failure would surface as a provider 400 on the first
// real cycle, which needs an API key and an hour of waiting to reach.
// A manifest that fails validation is skipped at load rather than crashing the process,
// which is right for an operator's own connector dir and wrong for the ones shipped here --
// so this is where a broken bundled manifest becomes a build failure.
if (CONNECTOR_ERRORS.length > 0) {
  throw new Error(
    `connector manifests failed to load:\n${CONNECTOR_ERRORS.map((e) => `  ${e.source}: ${e.message}`).join("\n")}`
  );
}

const registry = new ToolRegistry([
  ...buildMemoryTools(store),
  ...buildIntegrationsTools(),
  ...buildConnectorTools(),
  ...buildWebTools(),
]);
const schemas = registry.schemas(registry.names());
console.log(`registry: ${schemas.length} tools, all schemas serialized`);

// The catalog is what every phase's grant is built from. A name in the catalog with no tool
// behind it would be granted and then silently never fire. WebSearch is the deliberate
// exception: in native/none search mode there is no local tool, and agent-loop.ts reads the grant.
const missing = ALL_CATALOG_TOOLS.filter((name) => !registry.has(name) && name !== "WebSearch");
if (missing.length > 0) {
  throw new Error(`tool-catalog lists tools the registry doesn't provide: ${missing.join(", ")}`);
}
console.log("tool catalog matches the registry");

// The research-only invariant, checked structurally: every registered tool is a read or a write
// to this agent's own memory. A tool classifying as anything else -- a new write integration, a
// connector the catalog doesn't know -- fails the build here rather than reaching a phase.
const outside = registry.names().filter((name) => toolRisk(name) !== "read" && toolRisk(name) !== "memory");
if (outside.length > 0) {
  throw new Error(`registered tools outside read/memory (this agent must have no write tools): ${outside.join(", ")}`);
}
console.log("every registered tool is read-only or memory-only");

// ---- goals: what the loop is pointed at, and the one thing the agent may only suggest ----

const seeded = store.seedGoalsFromDomains(["print-on-demand storefronts for hobby communities"]);
const [goal] = store.listGoals();
console.log(`seeded ${seeded} goal(s):`, { id: goal.id, title: goal.title });

if (store.resolveGoalId("print-on-demand storefronts for hobby communities") !== goal.id) {
  throw new Error("resolveGoalId failed to match a goal by its own title");
}

// The core invariant, one level up from proposals: goal_suggest can only ever write an inert
// row. If a suggested goal ever reached activeGoals(), the agent would be choosing its own work.
const suggestedId = store.createGoal({
  title: "dropshipping storefronts",
  brief: "adjacent lane the agent thinks looks live",
  status: "suggested",
  origin: "agent",
  rationale: "print-on-demand kept coming up empty",
});
if (store.activeGoals().some((g) => g.id === suggestedId)) {
  throw new Error("a suggested goal reached activeGoals() -- it must be inert until a human accepts it");
}
if (store.resolveGoalId("dropshipping storefronts") !== null) {
  throw new Error("a suggested goal must not be resolvable as a filing target");
}
store.updateGoal(suggestedId, { status: "active" });
if (!store.activeGoals().some((g) => g.id === suggestedId)) {
  throw new Error("accepting a suggested goal should make it active");
}
store.updateGoal(suggestedId, { status: "retired" });
console.log("goal suggest/accept/dismiss round-trip OK");

const noteId = await store.addResearchNote(
  "pod-margins",
  "Print-on-demand margins average 20-30% after platform fees",
  "example.com",
  0.7,
  { goalId: goal.id, kind: "gap" }
);
console.log("note id", noteId);
console.log("search:", await store.searchResearchNotes("pod"));

const proposalId = store.createProposal({
  domain: "print-on-demand",
  description: "Launch a niche t-shirt line for a specific hobby community",
  expectedCost: 50,
  expectedTimeHours: 6,
  expectedUpside: 200,
  goalId: goal.id,
  revenueModel: "one_off",
  monetization: {
    whoPays: "members of one hobby community",
    pricePoint: "$25 per shirt",
    pathToFirstDollar: "a print-on-demand storefront with its checkout",
    daysToFirstDollar: 14,
    keyAssumption: "the community buys merch outside its own official store",
    validationSignal: "10 pre-orders from one forum post",
  },
  market: {
    marketSize: "~40k active forum members (estimate)",
    demandEvidence: [{ claim: "repeated merch requests in the forum", sourceUrl: "https://example.com/forum" }],
    competitors: [{ name: "Official store", pricing: "$35" }],
    keyRisks: ["licensing of community imagery"],
    viabilityScore: 2,
    confidence: "low",
  },
  steps: [
    { title: "Post a pre-order interest thread", doneWhen: "10 replies with intent to buy" },
    { title: "Open the storefront", doneWhen: "first order paid" },
  ],
});
console.log("proposal id", proposalId);
console.log("pending:", store.listPendingProposals());

store.decideProposal(proposalId, "approved", "looks reasonable, try it");
console.log("after decide:", store.getProposal(proposalId));

store.scheduleApprovedProposal(proposalId, { priority: "high", scheduledAt: null, recurrenceMs: null });
const scheduledNow = store.getProposal(proposalId)!;
if (scheduledNow.priority !== "high" || !scheduledNow.next_run_at) {
  throw new Error("scheduleApprovedProposal did not set priority/next_run_at as expected");
}
const due = store.listDueProposals(new Date().toISOString());
if (!due.some((p) => p.id === proposalId)) {
  throw new Error("listDueProposals did not surface a proposal due right now");
}
store.advanceOrClearSchedule(proposalId, { recurring: true, recurrenceMs: 600_000 });
if (!store.getProposal(proposalId)!.next_run_at) {
  throw new Error("advanceOrClearSchedule(recurring) should have rescheduled next_run_at, not cleared it");
}
store.cancelSchedule(proposalId);
if (store.getProposal(proposalId)!.next_run_at !== null) {
  throw new Error("cancelSchedule did not clear next_run_at");
}
console.log("scheduling round-trip OK");

store.logAction(proposalId, "act", "WebSearch", { query: "pod niches" }, { results: 3 });

// A deep dive's output. report_submit only accepts it while the deep dive is running, which
// is what markActStarted records.
store.markActStarted(proposalId);
const reportId = store.createReport({
  proposalId,
  goalId: goal.id,
  verdict: "drop",
  viabilityScore: 2,
  confidence: "medium",
  summary: "The niche is too small and the official store already covers it.",
  body: "## Summary\nToo small.",
  sources: [{ title: "Forum", url: "https://example.com/forum" }],
});
store.recordActVerdict(proposalId, { complete: true, problems: [] });
const latest = store.latestReportsByProposal().get(proposalId);
if (latest?.id !== reportId || latest.verdict !== "drop") {
  throw new Error("latestReportsByProposal did not return the report just written");
}
if (store.listReports({ goalId: goal.id }).length !== 1) {
  throw new Error("listReports did not find the report under its goal");
}
console.log("report id", reportId);

const lessonId = await store.addLesson(
  "print-on-demand",
  "Validate search volume for a niche before committing design time"
);
console.log("lesson id", lessonId);
await store.reinforceLesson(lessonId, "confirmed");
console.log("lessons:", await store.searchLessons("print-on-demand"));

// Writing the same lesson again must be refused rather than stored twice -- the live DB held
// two ~95%-identical lessons written 50 seconds apart before this guard existed.
const dupe = await store.findDuplicateLesson(
  "print-on-demand",
  "Validate the search volume for a niche before committing any design time"
);
if (!dupe) throw new Error("findDuplicateLesson missed a near-identical restatement");
console.log(`lesson dedup OK (matched #${dupe.row.id} at ${dupe.score.toFixed(2)})`);

store.logRun(proposalId, "act", 0.42, 5000, new Date().toISOString(), undefined, undefined, goal.id);

const [health] = store.goalHealth();
console.log("goal health:", {
  proposals: health.proposals,
  approved: health.approved,
  deepDives: health.deep_dives,
  emptyCycles: health.empty_cycles,
});

store.close();
console.log("SMOKE TEST OK");
