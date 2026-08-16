import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, parseMonetization, parseSteps } from "./memory-server.js";

/**
 * Qdrant is mocked so these tests are deterministic and need no cluster, independent of any
 * QDRANT_* env vars set in the ambient shell.
 *
 * `searchByText` returns null by default, which is the "search did not happen" signal -- so most
 * tests below exercise the LIKE-fallback path exactly as before. The `vectorHits` handle lets an
 * individual test script real scored hits instead, which is what gives the semantic path its
 * first coverage: previously it was mocked to null everywhere and nothing verified the
 * hydration, the ranking, or the empty-vs-failed distinction.
 */
const vectorHits: { next: { id: number; score: number }[] | null } = { next: null };

vi.mock("./qdrant.js", () => ({
  qdrantAvailable: false,
  searchByText: vi.fn(async () => vectorHits.next),
  recommendByText: vi.fn(async () => vectorHits.next),
  upsertText: vi.fn(async () => false),
  upsertMany: vi.fn(async () => false),
  setPayload: vi.fn(async () => false),
  deletePoint: vi.fn(async () => false),
  goalFilter: vi.fn(() => undefined),
  kindFilter: vi.fn(() => undefined),
  notMutedFilter: vi.fn(() => undefined),
  andFilters: vi.fn(() => undefined),
}));

beforeEach(() => {
  vectorHits.next = null;
});

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

describe("act status and the duplicate carve-out", () => {
  // The real shape of the #27 failure: an approved proposal whose build never landed, and a
  // follow-up that necessarily reads as a near-duplicate of it because finishing the work and
  // describing the work are the same words.
  const MACHWATCH = {
    domain: "IoT condition-monitoring prototype",
    description:
      "MachWatch, a working MQTT to dashboard to email-alert condition-monitoring prototype for small machine shops, deployed static to Vercel with threshold alerts",
    expectedCost: 0,
    expectedTimeHours: 5,
    expectedUpside: 1200,
    requiredTools: ["mcp__integrations__github_create_repo", "mcp__integrations__github_commit_files"],
  };
  const FOLLOW_UP = {
    domain: "IoT condition-monitoring prototype",
    description:
      "MachWatch, actually build the approved prototype: the MQTT dashboard condition-monitoring repo for small machine shops is empty, so commit the files and deploy it to Vercel with threshold alerts",
  };

  function approvedMachwatch() {
    const id = store.createProposal(MACHWATCH);
    store.decideProposal(id, "approved");
    return id;
  }

  it("blocks the follow-up while the original still counts as live work", () => {
    const id = approvedMachwatch();
    expect(store.findDuplicateProposal(FOLLOW_UP)?.proposal.id).toBe(id);

    // Mid-build is the one case where a duplicate really would be a duplicate.
    store.markActStarted(id);
    expect(store.findDuplicateProposal(FOLLOW_UP)?.proposal.id).toBe(id);

    store.recordActVerdict(id, { complete: true, problems: [] });
    expect(store.findDuplicateProposal(FOLLOW_UP)?.proposal.id).toBe(id);
  });

  it("allows the follow-up once the act phase is known not to have finished", () => {
    const id = approvedMachwatch();
    store.markActStarted(id);
    store.recordActVerdict(id, { complete: false, problems: ["outcome_record was never called."] });

    expect(store.findDuplicateProposal(FOLLOW_UP)).toBeNull();
    expect(store.getProposal(id)!.act_status).toBe("incomplete");
    expect(JSON.parse(store.getProposal(id)!.act_problems!)).toEqual(["outcome_record was never called."]);
  });

  it("allows the follow-up after the act phase was interrupted by a restart", () => {
    const id = approvedMachwatch();
    store.markActStarted(id);

    // The process dies here; the next one sweeps.
    expect(store.reapAfterUncleanShutdown().interrupted.map((p) => p.id)).toEqual([id]);
    expect(store.getProposal(id)!.act_status).toBe("interrupted");
    expect(store.findDuplicateProposal(FOLLOW_UP)).toBeNull();
  });

  it("lists unfinished acts for the operator, and clears one on a fresh attempt", () => {
    const interrupted = approvedMachwatch();
    store.markActStarted(interrupted);
    store.reapAfterUncleanShutdown();

    expect(store.listUnfinishedActs().map((p) => p.id)).toEqual([interrupted]);

    // Re-running act on it clears the marker until the new run reaches its own verdict.
    store.markActStarted(interrupted);
    expect(store.listUnfinishedActs()).toEqual([]);
    expect(store.getProposal(interrupted)!.act_problems).toBeNull();
  });

  it("leaves a proposal that never acted out of every act-status list", () => {
    const id = store.createProposal(MACHWATCH);
    store.decideProposal(id, "approved");
    expect(store.getProposal(id)!.act_status).toBeNull();
    expect(store.listUnfinishedActs()).toEqual([]);
    expect(store.reapAfterUncleanShutdown()).toEqual({ interrupted: [], descheduled: [] });
  });
});

describe("recovering from an unclean shutdown", () => {
  function approved(over: { recurrenceMs?: number | null } = {}) {
    const id = store.createProposal({
      domain: "IoT condition-monitoring prototype",
      description: "Build and deploy the MachWatch prototype",
      expectedCost: 0,
      expectedTimeHours: 5,
      expectedUpside: 1200,
      requiredTools: ["mcp__integrations__github_commit_files"],
    });
    store.decideProposal(id, "approved");
    store.scheduleApprovedProposal(id, {
      priority: "normal",
      scheduledAt: null,
      recurrenceMs: over.recurrenceMs ?? null,
    });
    return id;
  }

  it("descheduled an act phase that died, so it does not silently re-run", () => {
    const id = approved();
    // Approval always sets next_run_at; drainQueue's finally is what clears it, and a killed
    // process never gets there.
    expect(store.getProposal(id)!.next_run_at).not.toBeNull();
    store.markActStarted(id);

    const reaped = store.reapAfterUncleanShutdown();
    expect(reaped.interrupted.map((p) => p.id)).toEqual([id]);
    expect(reaped.descheduled.map((p) => p.id)).toEqual([id]);
    expect(store.getProposal(id)!.next_run_at).toBeNull();
    expect(store.listDueProposals(new Date().toISOString()).map((p) => p.id)).not.toContain(id);
  });

  it("also descheduled an act phase that finished but whose reflect was cut short", () => {
    const id = approved();
    store.markActStarted(id);
    store.recordActVerdict(id, { complete: true, problems: [] });
    // Process dies between act and reflect: act_status is 'complete' but next_run_at survives.

    const reaped = store.reapAfterUncleanShutdown();
    expect(reaped.interrupted).toEqual([]);
    expect(reaped.descheduled.map((p) => p.id)).toEqual([id]);
    expect(store.getProposal(id)!.next_run_at).toBeNull();
  });

  it("leaves a recurring proposal's schedule alone -- skipping real scheduled work is worse", () => {
    const id = approved({ recurrenceMs: 3_600_000 });
    store.markActStarted(id);

    const reaped = store.reapAfterUncleanShutdown();
    expect(reaped.interrupted.map((p) => p.id)).toEqual([id]);
    expect(reaped.descheduled).toEqual([]);
    expect(store.getProposal(id)!.next_run_at).not.toBeNull();
  });

  it("does not touch an approved proposal that has not acted yet", () => {
    const id = approved();
    const reaped = store.reapAfterUncleanShutdown();

    expect(reaped).toEqual({ interrupted: [], descheduled: [] });
    expect(store.getProposal(id)!.next_run_at).not.toBeNull();
    expect(store.listDueProposals(new Date().toISOString()).map((p) => p.id)).toContain(id);
  });

  it("is idempotent -- a clean second start finds nothing to repair", () => {
    const id = approved();
    store.markActStarted(id);
    store.reapAfterUncleanShutdown();

    expect(store.reapAfterUncleanShutdown()).toEqual({ interrupted: [], descheduled: [] });
    expect(store.getProposal(id)!.act_status).toBe("interrupted");
  });

  it("re-runs only on an explicit request, and only for approved work", () => {
    const id = approved();
    store.markActStarted(id);
    store.reapAfterUncleanShutdown();
    expect(store.getProposal(id)!.next_run_at).toBeNull();

    expect(store.requeueApprovedProposal(id)).toBe(true);
    expect(store.listDueProposals(new Date().toISOString()).map((p) => p.id)).toContain(id);

    const rejected = store.createProposal({
      domain: "d",
      description: "never approved",
      expectedCost: 0,
      expectedTimeHours: 1,
      expectedUpside: 0,
      requiredTools: [],
    });
    store.decideProposal(rejected, "rejected");
    expect(store.requeueApprovedProposal(rejected)).toBe(false);
    expect(store.requeueApprovedProposal(9999)).toBe(false);
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

describe("goals", () => {
  it("seeds one goal per configured domain, splitting the brief out of the title", () => {
    // The live domain that motivated this: a 400-character paragraph of research instructions
    // being used as a grouping key. The title has to become something readable without losing
    // a word of the original.
    const long =
      "micro-SaaS or web tool for the Swedish market -- research in Swedish (svenska sökord) " +
      "and target local pain points such as fakturering for enskild firma, priced in SEK";
    expect(store.seedGoalsFromDomains(["Chrome extensions", long])).toBe(2);

    const [chrome, swedish] = store.listGoals();
    expect(chrome).toMatchObject({ title: "Chrome extensions", brief: "Chrome extensions", status: "active" });
    expect(swedish.title).toBe("micro-SaaS or web tool for the Swedish market");
    expect(swedish.brief).toBe(long);
  });

  it("only seeds once, so AGENT_DOMAINS can't overwrite what the operator has since set", () => {
    store.seedGoalsFromDomains(["first"]);
    expect(store.seedGoalsFromDomains(["second", "third"])).toBe(0);
    expect(store.listGoals().map((g) => g.title)).toEqual(["first"]);
  });

  it("resolves a reworded domain onto the right goal, and an unrelated one onto none", () => {
    store.seedGoalsFromDomains(["micro-SaaS or web tool for the Swedish market"]);
    const [goal] = store.listGoals();

    expect(store.resolveGoalId("micro-SaaS or web tool for the Swedish market")).toBe(goal.id);
    expect(store.resolveGoalId("MICRO-SAAS OR WEB TOOL FOR THE SWEDISH MARKET")).toBe(goal.id);
    expect(store.resolveGoalId("web tool or micro-SaaS for the Swedish market")).toBe(goal.id);
    // No honest answer among the configured goals -- unassigned beats confidently wrong, because
    // a misfiled row puts a number on the scoreboard that isn't true.
    expect(store.resolveGoalId("VS Code extension for developers")).toBeNull();
    expect(store.resolveGoalId("")).toBeNull();
  });

  it("never resolves onto a suggested or retired goal", () => {
    const suggested = store.createGoal({ title: "affiliate comparison sites", status: "suggested", origin: "agent" });
    expect(store.resolveGoalId("affiliate comparison sites")).toBeNull();

    // Accepting it is what makes it real -- that's the whole invariant.
    store.updateGoal(suggested, { status: "active" });
    expect(store.resolveGoalId("affiliate comparison sites")).toBe(suggested);

    store.updateGoal(suggested, { status: "retired" });
    expect(store.resolveGoalId("affiliate comparison sites")).toBeNull();
  });

  it("refuses a suggestion that restates an existing goal, including a retired one", () => {
    store.createGoal({ title: "property management software comparison site", status: "retired" });
    // Re-suggesting a lane the operator already dismissed is the loop the guard exists to break.
    const match = store.findNearDuplicateGoal({
      title: "PropertyManagerCompare",
      brief: "a comparison site for property management software",
    });
    expect(match?.goal.status).toBe("retired");
    expect(store.findNearDuplicateGoal({ title: "Swedish tax calculators", brief: "skatt for enskild firma" })).toBeNull();
  });

  it("keeps the work when a goal is deleted, unassigning it rather than cascading", async () => {
    const goalId = store.createGoal({ title: "saas" });
    const proposalId = store.createProposal({
      domain: "saas",
      description: "something",
      expectedCost: 1,
      expectedTimeHours: 1,
      expectedUpside: 1,
      requiredTools: ["WebSearch"],
      goalId,
    });
    const lessonId = await store.addLesson("saas", "a lesson", undefined, { goalId });

    expect(store.deleteGoal(goalId)).toBe(true);
    expect(store.getProposal(proposalId)).toMatchObject({ id: proposalId, goal_id: null, domain: "saas" });
    expect(store.getLesson(lessonId)).toMatchObject({ id: lessonId, goal_id: null });
  });

  it("groups the scoreboard by goal title, leaving pre-goals rows under their own domain text", () => {
    const goalId = store.createGoal({ title: "Comparison sites" });
    // Two proposals, two different domain spellings, one goal -- the drift this fixes.
    for (const domain of ["affiliate comparison site", "comparison directory affiliate site"]) {
      store.createProposal({
        domain,
        description: `a site (${domain})`,
        expectedCost: 1,
        expectedTimeHours: 1,
        expectedUpside: 1,
        requiredTools: ["WebSearch"],
        goalId,
      });
    }
    // And one from before goals existed, which must stay visible rather than vanish.
    store.createProposal({
      domain: "legacy lane",
      description: "old work",
      expectedCost: 1,
      expectedTimeHours: 1,
      expectedUpside: 1,
      requiredTools: ["WebSearch"],
    });

    const byDomain = new Map(store.domainScoreboard().map((r) => [r.domain, r]));
    expect(byDomain.get("Comparison sites")?.proposals).toBe(2);
    expect(byDomain.get("legacy lane")?.proposals).toBe(1);
  });

  it("doesn't blame a goal for cycles that ran before it existed", () => {
    store.logRun(null, "research_plan", 0.1, 100, new Date(Date.now() - 60_000).toISOString());
    const goalId = store.createGoal({ title: "brand new lane" });
    // Seeding goals against an established DB otherwise reports every lane as long-failed and
    // trips the exploration mandate for all of them on day one.
    expect(store.goalHealth().find((h) => h.goal_id === goalId)?.empty_cycles).toBe(0);
  });
});

describe("memory dedup on write", () => {
  it("refuses a lesson that restates an existing one, via the lexical fallback", async () => {
    const text =
      "Before proposing a plan whose required tools include an integration's write actions, verify " +
      "that integration's credential is actually configured in this environment.";
    await store.addLesson("tooling", text);

    // The real store held two ~95%-identical credential lessons written 50 seconds apart into
    // two different domains -- the prompt already said to reinforce instead, and didn't hold.
    const match = await store.findDuplicateLesson(
      "VS Code extensions",
      "Before proposing a plan whose required tools include an integration's write actions, check " +
        "that the integration's credential is actually configured in this environment."
    );
    expect(match).not.toBeNull();
    expect(await store.findDuplicateLesson("saas", "Ship a landing page before writing any code")).toBeNull();
  });

  it("refuses a note that restates an existing one", async () => {
    await store.addResearchNote("pricing", "Developer tools convert best at a $9 to $19 monthly price point");
    const match = await store.findDuplicateNote(
      "pricing",
      "Developer tools convert best at a $9 to $19 per month price point"
    );
    expect(match?.row.topic).toBe("pricing");
    expect(await store.findDuplicateNote("hosting", "Static sites deploy free under a bandwidth cap")).toBeNull();
  });
});

describe("semantic search path", () => {
  // Everything above runs on the LIKE fallback. These script real vector hits, which had no
  // coverage at all before -- qdrant.js was mocked to null everywhere, so nothing verified the
  // hydration, the ranking, or that an empty result is distinguishable from a failed one.
  it("hydrates rows in the order Qdrant ranked them and carries the score through", async () => {
    const a = await store.addResearchNote("alpha", "first finding");
    const b = await store.addResearchNote("beta", "second finding");

    vectorHits.next = [
      { id: b, score: 0.91 },
      { id: a, score: 0.42 },
    ];
    const results = await store.searchResearchNotes("anything");
    expect(results.map((r) => r.id)).toEqual([b, a]);
    expect(results[0]).toMatchObject({ topic: "beta", score: 0.91 });
  });

  it("treats an empty vector result as a real answer, not as a reason to fall back", async () => {
    await store.addResearchNote("pricing", "Developer tools convert best at $9-19/mo");

    // null means "the search did not happen" -> LIKE fallback, which finds the row.
    vectorHits.next = null;
    expect(await store.searchResearchNotes("pricing")).toHaveLength(1);

    // [] means "the search ran and matched nothing". Conflating the two made a genuinely empty
    // semantic result quietly re-run as a substring match and return unrelated rows.
    vectorHits.next = [];
    expect(await store.searchResearchNotes("pricing")).toHaveLength(0);
  });

  it("re-ranks lessons by confidence, which pure similarity order ignores", async () => {
    const weak = await store.addLesson("saas", "a lesson nobody has confirmed");
    const strong = await store.addLesson("saas", "a lesson confirmed repeatedly");
    await store.reinforceLesson(strong, "confirmed");
    await store.reinforceLesson(strong, "confirmed");
    await store.reinforceLesson(strong, "confirmed");

    // Qdrant ranks the weak one first, but only just. Before blending, reinforcement was
    // recorded and then ignored the moment Qdrant was configured.
    vectorHits.next = [
      { id: weak, score: 0.62 },
      { id: strong, score: 0.6 },
    ];
    expect((await store.searchLessons("saas")).map((l) => l.id)).toEqual([strong, weak]);

    // Relevance still dominates: a big enough similarity gap isn't overturned by confidence.
    vectorHits.next = [
      { id: weak, score: 0.95 },
      { id: strong, score: 0.3 },
    ];
    expect((await store.searchLessons("saas")).map((l) => l.id)).toEqual([weak, strong]);
  });
});

describe("action history reach", () => {
  it("matches on goal id OR text, so work predating goals is still found", () => {
    const goalId = store.createGoal({ title: "Comparison sites" });
    const filed = store.createProposal({
      domain: "Comparison sites",
      description: "new work",
      expectedCost: 1,
      expectedTimeHours: 1,
      expectedUpside: 1,
      requiredTools: ["WebSearch"],
      goalId,
    });
    const legacy = store.createProposal({
      domain: "affiliate comparison site",
      description: "old work",
      expectedCost: 1,
      expectedTimeHours: 1,
      expectedUpside: 1,
      requiredTools: ["WebSearch"],
    });
    for (const id of [filed, legacy]) {
      store.decideProposal(id, "approved");
      store.logAction(id, "act", "mcp__integrations__github_create_repo", { name: "r" }, { url: "u" });
    }

    // goal_id alone reaches only the new one; that was the old exact-domain filter's failure,
    // which reported "nothing built here" for a lane that had shipped.
    expect(store.listActionHistory({ goalId }).map((r) => r.proposalId)).toEqual([filed]);
    expect(store.listActionHistory({ goalId, text: "affiliate comparison" }).map((r) => r.proposalId).sort()).toEqual(
      [filed, legacy].sort()
    );
    expect(store.listActionHistory({})).toHaveLength(2);
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

// The tool wrapper, not just the store: the monetization block and the steps↔fence
// cross-check only exist at the proposal_create boundary, and that check is the whole
// reason the step list is worth storing -- a plan whose steps need tools the fence
// doesn't grant is a plan that cannot run, stated as though it can.
describe("proposal_create", () => {
  const baseArgs = {
    domain: "saas",
    description: "**Invoice Lint** — a linter for invoice templates.\n\n- Ships as a CLI",
    expectedCost: 20,
    expectedTimeHours: 6,
    expectedUpside: 400,
    requiredTools: ["mcp__integrations__github_create_repo"],
    revenueModel: "one_off" as const,
    monetization: {
      whoPays: "Freelance bookkeepers",
      pricePoint: "$19 one-off",
      pathToFirstDollar: "Stripe payment link on the README",
      daysToFirstDollar: 14,
      keyAssumption: "Bookkeepers will pay for a linter rather than eyeballing templates",
      validationSignal: "First 3 paid downloads within two weeks",
    },
    steps: [
      { title: "Create the repo", owner: "agent" as const, tool: "mcp__integrations__github_create_repo", doneWhen: "Repo exists with the CLI committed" },
      { title: "Publish the payment link", owner: "human" as const, doneWhen: "Link resolves and accepts a test card" },
    ],
  };

  async function create(args: Record<string, unknown>) {
    const { buildMemoryTools } = await import("./memory-server.js");
    const { ToolRegistry } = await import("./tools/registry.js");
    const registry = new ToolRegistry(buildMemoryTools(store));
    return registry.invoke("mcp__memory__proposal_create", args);
  }

  it("stores the monetization block and steps on the row", async () => {
    const res = await create(baseArgs);
    expect(res.isError).toBe(false);

    const [row] = store.listAllProposals();
    expect(row.revenue_model).toBe("one_off");
    expect(parseMonetization(row)?.pathToFirstDollar).toBe("Stripe payment link on the README");
    expect(parseSteps(row).map((s) => s.owner)).toEqual(["agent", "human"]);
  });

  it("refuses when an agent step needs a tool the fence doesn't grant", async () => {
    const res = await create({
      ...baseArgs,
      steps: [
        ...baseArgs.steps,
        { title: "Deploy the landing page", owner: "agent", tool: "mcp__integrations__vercel_deploy", doneWhen: "Site is live" },
      ],
    });

    expect(res.isError).toBe(false); // refused in band, like the duplicate check -- not an exception
    expect(res.text).toContain("Not created");
    expect(res.text).toContain("mcp__integrations__vercel_deploy");
    expect(store.listAllProposals()).toHaveLength(0);
  });

  it("allows a human step to have no tool -- that's the point of marking it human", async () => {
    const res = await create({
      ...baseArgs,
      steps: [
        baseArgs.steps[0],
        { title: "Register for the affiliate programme", owner: "human", doneWhen: "Approval email received" },
      ],
    });
    expect(res.text).toContain("Created proposal");
  });

  it("rejects a proposal with no monetization block at all", async () => {
    const { monetization: _omitted, ...withoutMonetization } = baseArgs;
    const res = await create(withoutMonetization);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("monetization");
    expect(store.listAllProposals()).toHaveLength(0);
  });
});
