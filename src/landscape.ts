// src/landscape.ts
//
// A goal's market landscape: everything the record already holds about one lane, arranged so
// an operator can read the market off it. Derived on read, like the old deliverables view --
// no state of its own to keep in step with the notes, ideas and reports it is built from.
//
// Pure (rows in, structure out), so it needs no store and no API key, and is unit-tested in
// landscape.test.ts.

import { parseMarket, type MarketAssessment, type ProposalRow, type ReportSummary } from "./memory-server.js";

interface NoteLike {
  id: number;
  topic: string;
  kind: string | null;
}

/**
 * The order note groups are shown in: what is open first, what is known about the market next,
 * dead ends last. A kind not listed here (a future one, or spec/inventory/meta) follows, and
 * unclassified notes come at the very end.
 */
export const LANDSCAPE_KIND_ORDER = ["gap", "demand", "market_size", "competitor", "pricing", "risk", "saturated"];

/** `kind`, with the same legacy bridge `listSaturatedNotes` uses for rows written before kinds existed. */
export function effectiveKind(note: NoteLike): string {
  if (note.kind) return note.kind;
  return /saturat/i.test(note.topic) ? "saturated" : "unclassified";
}

export function groupNotesByKind<N extends NoteLike>(notes: N[]): { kind: string; notes: N[] }[] {
  const groups = new Map<string, N[]>();
  for (const note of notes) {
    const kind = effectiveKind(note);
    groups.set(kind, [...(groups.get(kind) ?? []), note]);
  }
  const rank = (kind: string) => {
    if (kind === "unclassified") return Number.MAX_SAFE_INTEGER;
    const i = LANDSCAPE_KIND_ORDER.indexOf(kind);
    return i === -1 ? LANDSCAPE_KIND_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([kind, grouped]) => ({ kind, notes: grouped }));
}

export interface LandscapeCompetitor {
  name: string;
  url?: string;
  pricing?: string;
  gap?: string;
  /** Every idea whose market block named this competitor. */
  ideaIds: number[];
}

/**
 * Competitors named across a goal's ideas, merged by name (case-insensitive). The first mention
 * supplies the details, later ones fill any gaps -- an idea that only knew the name shouldn't
 * blank out one that also knew the price.
 */
export function mergeCompetitors(ideas: { id: number; market: MarketAssessment | null }[]): LandscapeCompetitor[] {
  const byName = new Map<string, LandscapeCompetitor>();
  for (const idea of ideas) {
    for (const c of idea.market?.competitors ?? []) {
      const key = c.name.trim().toLowerCase();
      if (!key) continue;
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, { name: c.name.trim(), url: c.url, pricing: c.pricing, gap: c.gap, ideaIds: [idea.id] });
        continue;
      }
      existing.url ??= c.url;
      existing.pricing ??= c.pricing;
      existing.gap ??= c.gap;
      if (!existing.ideaIds.includes(idea.id)) existing.ideaIds.push(idea.id);
    }
  }
  return [...byName.values()].sort((a, b) => b.ideaIds.length - a.ideaIds.length || a.name.localeCompare(b.name));
}

export function buildLandscape<N extends NoteLike>(input: {
  notes: N[];
  proposals: ProposalRow[];
  reports: Map<number, ReportSummary>;
}) {
  const ideas = input.proposals.map((proposal) => ({
    proposal,
    market: parseMarket(proposal),
    report: input.reports.get(proposal.id) ?? null,
  }));
  const verdicts = ideas.map((i) => i.report?.verdict);
  return {
    notes: groupNotesByKind(input.notes),
    ideas,
    competitors: mergeCompetitors(ideas.map((i) => ({ id: i.proposal.id, market: i.market }))),
    counts: {
      notes: input.notes.length,
      ideas: ideas.length,
      pursue: verdicts.filter((v) => v === "pursue").length,
      maybe: verdicts.filter((v) => v === "maybe").length,
      drop: verdicts.filter((v) => v === "drop").length,
    },
  };
}
