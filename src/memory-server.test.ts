import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./memory-server.js";

// Qdrant is mocked out entirely so these tests exercise the LIKE-fallback
// search path deterministically, independent of any QDRANT_* env vars set
// in the ambient shell.
vi.mock("./qdrant.js", () => ({
  qdrantAvailable: false,
  searchByText: vi.fn(async () => null),
  upsertText: vi.fn(async () => false),
}));

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("research notes", () => {
  it("adds a note and finds it again via LIKE fallback search", async () => {
    const id = await store.addResearchNote(
      "pod-margins",
      "Print-on-demand margins average 20-30% after platform fees",
      "example.com",
      0.7
    );
    expect(id).toBeGreaterThan(0);

    const results = await store.searchResearchNotes("pod");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id, topic: "pod-margins", source: "example.com" });
  });

  it("lists all notes", async () => {
    await store.addResearchNote("a", "finding a");
    await store.addResearchNote("b", "finding b");
    const all = store.listAllResearchNotes();
    expect(all.map((n) => n.topic).sort()).toEqual(["a", "b"]);
  });
});

describe("proposals", () => {
  function createProposal() {
    return store.createProposal({
      domain: "print-on-demand",
      description: "Launch a niche t-shirt line for a specific hobby community",
      expectedCost: 50,
      expectedTimeHours: 6,
      expectedUpside: 200,
      requiredTools: ["WebSearch", "WebFetch"],
    });
  }

  it("creates a proposal that shows up as pending", () => {
    const id = createProposal();
    expect(store.listPendingProposals().map((p) => p.id)).toContain(id);
  });

  it("records a decision", () => {
    const id = createProposal();
    store.decideProposal(id, "approved", "looks reasonable, try it");
    const proposal = store.getProposal(id);
    expect(proposal?.status).toBe("approved");
    expect(proposal?.human_notes).toBe("looks reasonable, try it");
  });

  it("round-trips scheduling: schedule, find as due, advance, cancel", () => {
    const id = createProposal();
    store.decideProposal(id, "approved");

    store.scheduleApprovedProposal(id, { priority: "high", scheduledAt: null, recurrenceMs: null });
    const scheduled = store.getProposal(id)!;
    expect(scheduled.priority).toBe("high");
    expect(scheduled.next_run_at).not.toBeNull();

    const due = store.listDueProposals(new Date().toISOString());
    expect(due.some((p) => p.id === id)).toBe(true);

    store.advanceOrClearSchedule(id, { recurring: true, recurrenceMs: 600_000 });
    expect(store.getProposal(id)!.next_run_at).not.toBeNull();

    store.cancelSchedule(id);
    expect(store.getProposal(id)!.next_run_at).toBeNull();
  });
});

describe("outcomes and lessons", () => {
  it("records an outcome and derives a lesson from it", async () => {
    const proposalId = store.createProposal({
      domain: "print-on-demand",
      description: "Launch a niche t-shirt line",
      expectedCost: 50,
      expectedTimeHours: 6,
      expectedUpside: 200,
      requiredTools: ["WebSearch"],
    });
    store.decideProposal(proposalId, "approved");
    store.logAction(proposalId, "act", "WebSearch", { query: "pod niches" }, { results: 3 });

    const outcomeId = store.recordOutcome({
      proposalId,
      actualRevenue: 40,
      actualCost: 55,
      actualTimeHours: 7,
      success: false,
      notes: "niche was too small, low search volume",
    });
    expect(outcomeId).toBeGreaterThan(0);

    const lessonId = await store.addLesson(
      "print-on-demand",
      "Validate search volume for a niche before committing design time",
      outcomeId
    );
    store.reinforceLesson(lessonId, "confirmed");

    const lessons = await store.searchLessons("print-on-demand");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ id: lessonId, times_reinforced: 1, confidence: 0.6 });
  });

  it("adjusts confidence down and increments times_contradicted on a contradicted lesson", async () => {
    const lessonId = await store.addLesson("saas", "Ship a landing page before writing code");
    store.reinforceLesson(lessonId, "contradicted");
    const [lesson] = await store.searchLessons("saas");
    expect(lesson).toMatchObject({ times_contradicted: 1 });
    expect(lesson.confidence).toBeCloseTo(0.3);
  });
});

describe("runs", () => {
  it("sums logged run costs", () => {
    store.logRun(null, "research", 0.12, 1000, new Date().toISOString());
    store.logRun(null, "act", 0.3, 2000, new Date().toISOString());
    expect(store.totalRunCost()).toBeCloseTo(0.42);
  });
});
