import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./memory-server.js";

// Qdrant is mocked out entirely so these tests exercise the LIKE-fallback
// search path deterministically, independent of any QDRANT_* env vars set
// in the ambient shell.
vi.mock("./qdrant.js", () => ({
  qdrantAvailable: false,
  searchByText: vi.fn(async () => null),
  upsertText: vi.fn(async () => false),
  deletePoint: vi.fn(async () => false),
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

describe("lesson curation", () => {
  it("hides a muted lesson from search without deleting it", async () => {
    const id = await store.addLesson("saas", "Ship a landing page before writing code");
    expect(await store.searchLessons("saas")).toHaveLength(1);

    store.setLessonMuted(id, true);
    // The whole point of muting: it stops steering the agent, but the record survives.
    expect(await store.searchLessons("saas")).toHaveLength(0);
    expect(store.getLesson(id)).toMatchObject({ id, muted: 1 });
    expect(store.listAllLessons().map((l) => l.id)).toContain(id);

    store.setLessonMuted(id, false);
    expect(await store.searchLessons("saas")).toHaveLength(1);
  });

  it("edits a lesson's text while keeping its id and track record", async () => {
    const id = await store.addLesson("saas", "Origianl typo'd lesson");
    store.reinforceLesson(id, "confirmed");

    expect(await store.editLesson(id, { lesson: "Corrected lesson text" })).toBe(true);
    const edited = store.getLesson(id)!;
    expect(edited).toMatchObject({ id, lesson: "Corrected lesson text", times_reinforced: 1 });
    expect(edited.edited_at).not.toBeNull();
  });

  it("deletes a lesson outright", async () => {
    const id = await store.addLesson("saas", "A lesson that turned out to be wrong");
    await store.deleteLesson(id);
    expect(store.getLesson(id)).toBeUndefined();
    expect(await store.searchLessons("saas")).toHaveLength(0);
  });
});

describe("research note dedupe", () => {
  it("flags near-duplicate notes and leaves distinct ones alone", async () => {
    await store.addResearchNote("pricing", "Developer tools convert best at a $9 to $19 monthly price point");
    await store.addResearchNote("pricing", "Developer tools convert best around a $9 to $19 per month price point");
    await store.addResearchNote("hosting", "Static sites deploy free on most platforms under a bandwidth cap");

    const dupes = store.findDuplicateResearchNotes();
    expect(dupes).toHaveLength(1);
    expect(dupes[0].similarity).toBeGreaterThan(0.6);
  });

  it("merges duplicates into the keeper, preserving the other's source", async () => {
    const keepId = await store.addResearchNote("pricing", "Dev tools convert at $9-19/mo", "a.example", 0.5);
    const dupeId = await store.addResearchNote("pricing", "Dev tools convert at $9-19 monthly", "b.example", 0.9);

    expect(await store.mergeResearchNotes(keepId, [dupeId])).toBe(true);
    const remaining = store.listAllResearchNotes();
    expect(remaining.map((n) => n.id)).toEqual([keepId]);
    expect(remaining[0].finding).toContain("b.example");
    // Keeps the strongest confidence claimed by any of the merged notes, not just the keeper's.
    expect(remaining[0].confidence).toBeCloseTo(0.9);
  });
});

describe("proposal scope edits", () => {
  it("records what the model originally proposed when a human narrows the fence", () => {
    const id = store.createProposal({
      domain: "saas",
      description: "Build and deploy a landing page",
      expectedCost: 10,
      expectedTimeHours: 2,
      expectedUpside: 100,
      requiredTools: ["mcp__integrations__github_create_repo", "mcp__integrations__vercel_deploy"],
    });

    store.applyProposalEdits(id, { requiredTools: ["mcp__integrations__github_create_repo"] });
    const edited = store.getProposal(id)!;
    expect(edited.required_tools).toBe("mcp__integrations__github_create_repo");
    expect(edited.original_required_tools).toBe(
      "mcp__integrations__github_create_repo,mcp__integrations__vercel_deploy"
    );
  });

  it("keeps the first original through a second edit", () => {
    const id = store.createProposal({
      domain: "saas",
      description: "First",
      expectedCost: 1,
      expectedTimeHours: 1,
      expectedUpside: 1,
      requiredTools: ["WebSearch"],
    });
    store.applyProposalEdits(id, { description: "Second" });
    store.applyProposalEdits(id, { description: "Third" });
    expect(store.getProposal(id)!.original_description).toBe("First");
  });
});

describe("economics", () => {
  it("sums logged run costs", () => {
    store.logRun(null, "research", 0.12, 1000, new Date().toISOString());
    store.logRun(null, "act", 0.3, 2000, new Date().toISOString());
    expect(store.totalRunCost()).toBeCloseTo(0.42);
  });

  it("scores a domain on outcomes, spend, and forecast accuracy", () => {
    const id = store.createProposal({
      domain: "saas",
      description: "A thing",
      expectedCost: 10,
      expectedTimeHours: 2,
      expectedUpside: 500,
      requiredTools: ["WebSearch"],
    });
    store.decideProposal(id, "approved");
    store.recordOutcome({ proposalId: id, actualRevenue: 120, actualCost: 30, success: true });
    store.logRun(id, "act", 0.25, 1000, new Date().toISOString());

    const [row] = store.domainScoreboard();
    expect(row).toMatchObject({
      domain: "saas",
      proposals: 1,
      approved: 1,
      successes: 1,
      revenue: 120,
      reported_cost: 30,
      forecast_upside: 500, // vs 120 actual -- the gap is the point of tracking it
    });
    expect(row.api_spend).toBeCloseTo(0.25);
  });

  it("groups spend by phase", () => {
    store.logRun(null, "research_plan", 0.1, 100, new Date().toISOString());
    store.logRun(null, "research_plan", 0.2, 100, new Date().toISOString());
    store.logRun(null, "act", 0.05, 100, new Date().toISOString());

    const byPhase = store.spendByPhase();
    expect(byPhase.find((p) => p.phase === "research_plan")).toMatchObject({ runs: 2 });
    expect(byPhase.find((p) => p.phase === "research_plan")!.cost_usd).toBeCloseTo(0.3);
  });

  it("separates spend by provider/model and keeps pre-tracking runs in their own bucket", () => {
    store.logRun(null, "research_plan", 0.1, 100, new Date().toISOString(), "openrouter", "deepseek/v4");
    store.logRun(null, "act", 0.2, 100, new Date().toISOString(), "openrouter", "deepseek/v4");
    // No provider/model: a row from before those columns existed. Folding it into the
    // configured provider would credit one vendor with another's spend.
    store.logRun(null, "act", 5, 100, new Date().toISOString());

    const byModel = store.spendByModel();
    expect(byModel.find((m) => m.model === "deepseek/v4")).toMatchObject({ provider: "openrouter", runs: 2 });
    expect(byModel.find((m) => m.model === "deepseek/v4")!.cost_usd).toBeCloseTo(0.3);
    expect(byModel.find((m) => m.provider === null)!.cost_usd).toBeCloseTo(5);
  });

  it("reports spend charged to no proposal, which the domain scoreboard cannot see", () => {
    const id = store.createProposal({
      domain: "saas",
      description: "A thing",
      expectedCost: 1,
      expectedTimeHours: 1,
      expectedUpside: 1,
      requiredTools: [],
    });
    store.logRun(null, "research_plan", 0.4, 100, new Date().toISOString());
    store.logRun(id, "act", 0.1, 100, new Date().toISOString());

    expect(store.unattributedSpend()).toBeCloseTo(0.4);
    expect(store.totalRunCost() - store.unattributedSpend()).toBeCloseTo(0.1);
  });
});

describe("operator control settings", () => {
  it("round-trips each knob and leaves unset keys absent", () => {
    expect(store.loadControlSettings()).toEqual({});

    store.saveControlSettings({ domains: ["a", "b"], paused: true });
    expect(store.loadControlSettings()).toEqual({ domains: ["a", "b"], paused: true });

    // A patch only touches the keys it names -- saving a directive must not drop the domains.
    store.saveControlSettings({ directive: "focus on X" });
    expect(store.loadControlSettings()).toEqual({ domains: ["a", "b"], paused: true, directive: "focus on X" });

    // Consuming a directive persists the clear, so it can't survive being used.
    store.saveControlSettings({ directive: null });
    expect(store.loadControlSettings().directive).toBeNull();
  });

  it("drops a value of the wrong shape rather than handing it to the loop", () => {
    // A row left by an older/hand-edited schema. Startup must fall back to the env default
    // for that key instead of seeding the control state with a string where a list belongs.
    store.saveControlSettings({ domains: "not-a-list" as unknown as string[], paused: true });
    expect(store.loadControlSettings()).toEqual({ paused: true });
  });
});

describe("unified search", () => {
  it("returns hits across proposals, lessons, and notes", async () => {
    store.createProposal({
      domain: "saas",
      description: "A Chrome extension for invoicing",
      expectedCost: 1,
      expectedTimeHours: 1,
      expectedUpside: 1,
      requiredTools: ["WebSearch"],
    });
    await store.addLesson("saas", "Invoicing tools need a free tier to get traction");
    await store.addResearchNote("invoicing", "Invoicing SaaS is crowded but margins are high");

    const hits = await store.searchEverything("invoicing");
    expect(hits.map((h) => h.type).sort()).toEqual(["lesson", "proposal", "research_note"]);
  });
});
