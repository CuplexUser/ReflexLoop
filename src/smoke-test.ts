import "dotenv/config";
import { buildIntegrationsTools } from "./integrations-server.js";
import { buildWebTools } from "./tools/web.js";
import { ToolRegistry } from "./tools/registry.js";
import { ALL_GRANTABLE_TOOLS } from "./tool-catalog.js";
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
const registry = new ToolRegistry([...buildMemoryTools(store), ...buildIntegrationsTools(), ...buildWebTools()]);
const schemas = registry.schemas(registry.names());
console.log(`registry: ${schemas.length} tools, all schemas serialized`);

// The catalog is what server.ts validates an operator's required_tools edits against and
// what the console badges. A name in the catalog with no tool behind it would look
// grantable and then silently never fire. WebSearch is the deliberate exception: in
// native/none search mode there is no local tool, and agent-loop.ts reads the grant.
const missing = ALL_GRANTABLE_TOOLS.filter((name) => !registry.has(name) && name !== "WebSearch");
if (missing.length > 0) {
  throw new Error(`tool-catalog lists tools the registry doesn't provide: ${missing.join(", ")}`);
}
console.log("tool catalog matches the registry");

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
  requiredTools: ["WebSearch", "WebFetch"],
  goalId: goal.id,
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

const outcomeId = store.recordOutcome({
  proposalId,
  actualRevenue: 40,
  actualCost: 55,
  actualTimeHours: 7,
  success: false,
  notes: "niche was too small, low search volume",
});
console.log("outcome id", outcomeId);

const lessonId = await store.addLesson(
  "print-on-demand",
  "Validate search volume for a niche before committing design time",
  outcomeId
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
  shipped: health.shipped,
  emptyCycles: health.empty_cycles,
});

store.close();
console.log("SMOKE TEST OK");
