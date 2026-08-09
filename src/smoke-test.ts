import "dotenv/config";
import { MemoryStore, buildMemoryServer } from "./memory-server.js";
import { unlinkSync, existsSync } from "node:fs";

const dbPath = "./data/smoke-test.db";
if (existsSync(dbPath)) unlinkSync(dbPath);

const store = new MemoryStore(dbPath);
buildMemoryServer(store); // just confirm this doesn't throw

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
