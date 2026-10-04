import { describe, expect, it } from "vitest";
import { buildLandscape, effectiveKind, groupNotesByKind, mergeCompetitors } from "./landscape.js";
import type { MarketAssessment, ProposalRow, ReportSummary } from "./memory-server.js";

const note = (id: number, kind: string | null, topic = `topic ${id}`) => ({ id, kind, topic });

const market = (competitors: MarketAssessment["competitors"]): MarketAssessment => ({
  marketSize: "~2,000 firms (estimate)",
  demandEvidence: [{ claim: "people ask for it", sourceUrl: "https://example.com" }],
  competitors,
  keyRisks: ["incumbents copy it"],
  viabilityScore: 3,
  confidence: "medium",
});

describe("effectiveKind", () => {
  it("bridges legacy saturation notes the same way listSaturatedNotes does", () => {
    expect(effectiveKind(note(1, null, "Invoice tools -- saturated Aug 2026"))).toBe("saturated");
    expect(effectiveKind(note(2, null, "Invoice tools"))).toBe("unclassified");
    expect(effectiveKind(note(3, "gap", "saturation of nothing"))).toBe("gap");
  });
});

describe("groupNotesByKind", () => {
  it("orders open ground first, dead ends after, unclassified last", () => {
    const groups = groupNotesByKind([note(1, null), note(2, "saturated"), note(3, "meta"), note(4, "gap"), note(5, "pricing")]);
    expect(groups.map((g) => g.kind)).toEqual(["gap", "pricing", "saturated", "meta", "unclassified"]);
  });
});

describe("mergeCompetitors", () => {
  it("merges by name across ideas and fills in missing details", () => {
    const merged = mergeCompetitors([
      { id: 1, market: market([{ name: "Fortnox" }, { name: "Bokio", pricing: "free tier" }]) },
      { id: 2, market: market([{ name: "fortnox ", pricing: "$30/mo", url: "https://fortnox.se" }]) },
      { id: 3, market: null },
    ]);
    expect(merged[0]).toEqual({ name: "Fortnox", url: "https://fortnox.se", pricing: "$30/mo", gap: undefined, ideaIds: [1, 2] });
    expect(merged[1].name).toBe("Bokio");
  });
});

describe("buildLandscape", () => {
  it("counts verdicts from each idea's latest report", () => {
    const proposal = (id: number, market_json: string | null) => ({ id, market_json }) as ProposalRow;
    const report = (proposal_id: number, verdict: "pursue" | "maybe" | "drop") => ({ proposal_id, verdict }) as ReportSummary;
    const landscape = buildLandscape({
      notes: [note(1, "gap")],
      proposals: [proposal(1, JSON.stringify(market([]))), proposal(2, null), proposal(3, null)],
      reports: new Map([
        [1, report(1, "pursue")],
        [3, report(3, "drop")],
      ]),
    });
    expect(landscape.counts).toEqual({ notes: 1, ideas: 3, pursue: 1, maybe: 0, drop: 1 });
    expect(landscape.ideas[1].market).toBeNull();
  });
});
