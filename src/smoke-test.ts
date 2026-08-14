import "dotenv/config";
import { MemoryStore, buildMemoryTools } from "./memory-server.js";
import { buildIntegrationsTools } from "./integrations-server.js";
import { buildWebTools } from "./tools/web.js";
import { ToolRegistry } from "./tools/registry.js";
import { ALL_GRANTABLE_TOOLS } from "./tool-catalog.js";
import { unlinkSync, existsSync } from "node:fs";

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

const noteId = await store.addResearchNote(
  "pod-margins",
  "Print-on-demand margins average 20-30% after platform fees",
  "example.com",
  0.7
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
store.reinforceLesson(lessonId, "confirmed");
console.log("lessons:", await store.searchLessons("print-on-demand"));

store.logRun(proposalId, "act", 0.42, 5000, new Date().toISOString());

store.close();
console.log("SMOKE TEST OK");
