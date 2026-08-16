// web/src/monetization.ts
//
// Parsing and labelling for the monetization block a proposal carries. Kept out of
// MonetizationBlock.tsx so that file exports only components (fast refresh needs that),
// and because the proposals table uses these without rendering the block at all.

import type { Monetization, OutcomeRow, ProposalRow, ProposalStep, RevenueModel } from './types'

const REVENUE_MODEL_LABEL: Record<RevenueModel, string> = {
  affiliate: 'Affiliate',
  subscription: 'Subscription',
  one_off: 'One-off sale',
  ads: 'Ads',
  marketplace: 'Marketplace',
  service: 'Service',
  lead_gen: 'Lead generation',
  other: 'Other',
}

export const REVENUE_MODELS = Object.keys(REVENUE_MODEL_LABEL) as RevenueModel[]

export function revenueModelLabel(model: RevenueModel | null): string | null {
  return model ? (REVENUE_MODEL_LABEL[model] ?? model) : null
}

/** Null for a proposal filed before the monetization block existed, or one with unreadable JSON. */
export function parseMonetization(proposal: Pick<ProposalRow, 'monetization_json'>): Monetization | null {
  if (!proposal.monetization_json) return null
  try {
    return JSON.parse(proposal.monetization_json) as Monetization
  } catch {
    return null
  }
}

export function parseSteps(proposal: Pick<ProposalRow, 'steps_json'>): ProposalStep[] {
  if (!proposal.steps_json) return []
  try {
    const parsed = JSON.parse(proposal.steps_json)
    return Array.isArray(parsed) ? (parsed as ProposalStep[]) : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Aggregation for the Economics page's monetization section.
//
// All of it is derived on read from `proposals` + `outcomes`, both of which App
// already holds -- there is no endpoint, no SQL and no stored state behind any
// figure here, so none of it can disagree with the rows it came from.
// ---------------------------------------------------------------------------

/** Why we believe a proposal's act phase actually ran. */
export type ExecutionEvidence = 'outcome' | 'review' | null

const DAY_MS = 86_400_000

/**
 * Outcomes keyed by proposal, as arrays rather than one row each.
 *
 * `outcomes.proposal_id` carries no UNIQUE constraint and `outcome_record` does no dedup, while
 * proposals can recur -- so several rows for one proposal is structurally possible. Every realized
 * figure sums them; a `Map<number, OutcomeRow>` would silently keep the last and under-report.
 */
export function groupOutcomes(outcomes: OutcomeRow[]): Map<number, OutcomeRow[]> {
  const byProposal = new Map<number, OutcomeRow[]>()
  for (const outcome of outcomes) {
    const existing = byProposal.get(outcome.proposal_id)
    if (existing) existing.push(outcome)
    else byProposal.set(outcome.proposal_id, [outcome])
  }
  return byProposal
}

/**
 * `outcome_record` is a *model* call at the end of the act phase, so a crashed or abandoned phase
 * leaves no row at all. A human `review_status` is the other evidence that real work exists -- a
 * person judged a deliverable. Counting only outcomes reports 4 of the 8 approved proposals as
 * executed when 6 of them produced something; counting either is the honest test.
 */
export function executionEvidence(
  proposal: ProposalRow,
  byProposal: Map<number, OutcomeRow[]>,
): ExecutionEvidence {
  if ((byProposal.get(proposal.id)?.length ?? 0) > 0) return 'outcome'
  if (proposal.review_status !== null) return 'review'
  return null
}

function sumUpside(proposals: ProposalRow[]): number {
  return proposals.reduce((total, p) => total + p.expected_upside, 0)
}

function sumRevenue(rows: OutcomeRow[] | undefined): number {
  return (rows ?? []).reduce((total, o) => total + o.actual_revenue, 0)
}

export interface FunnelStage {
  key: 'proposed' | 'approved' | 'acted' | 'earning'
  label: string
  count: number
  /** Sum of expected_upside. Can be negative -- expectedUpside is z.number() with no .min(0). */
  upside: number
  /** Members claiming exactly 0, i.e. why the count and money series move independently. */
  zeroUpsideCount: number
}

export interface MonetizationFunnel {
  /** Always four, in order, even when every count is zero. Strictly nested subsets. */
  stages: FunnelStage[]
  rejected: { count: number; upside: number }
  pending: { count: number; upside: number }
  /** The breakdown behind `acted`, printed under it so the definition is visible. */
  actedEvidence: { withOutcome: number; reviewedOnly: number }
  /** Approved with neither signal -- work that was authorised and never happened. */
  approvedNoEvidence: { count: number; upside: number; ids: number[] }
  realized: number
  outcomeRows: number
  outcomeProposals: number
  totalProposals: number
}

export function buildFunnel(proposals: ProposalRow[], outcomes: OutcomeRow[]): MonetizationFunnel {
  const byProposal = groupOutcomes(outcomes)

  const approved = proposals.filter((p) => p.status === 'approved')
  const rejected = proposals.filter((p) => p.status === 'rejected')
  const pending = proposals.filter((p) => p.status === 'pending')

  // Nested inside `approved` on purpose: an unnested stage is a bar chart pretending to be a funnel.
  const acted = approved.filter((p) => executionEvidence(p, byProposal) !== null)
  const earning = approved.filter((p) => sumRevenue(byProposal.get(p.id)) > 0)
  const noEvidence = approved.filter((p) => executionEvidence(p, byProposal) === null)

  const stage = (
    key: FunnelStage['key'],
    label: string,
    members: ProposalRow[],
  ): FunnelStage => ({
    key,
    label,
    count: members.length,
    upside: sumUpside(members),
    zeroUpsideCount: members.filter((p) => p.expected_upside === 0).length,
  })

  return {
    stages: [
      stage('proposed', 'Proposed', proposals),
      stage('approved', 'Approved', approved),
      stage('acted', 'Acted on', acted),
      stage('earning', 'Earning', earning),
    ],
    rejected: { count: rejected.length, upside: sumUpside(rejected) },
    pending: { count: pending.length, upside: sumUpside(pending) },
    actedEvidence: {
      withOutcome: acted.filter((p) => executionEvidence(p, byProposal) === 'outcome').length,
      reviewedOnly: acted.filter((p) => executionEvidence(p, byProposal) === 'review').length,
    },
    approvedNoEvidence: {
      count: noEvidence.length,
      upside: sumUpside(noEvidence),
      ids: noEvidence.map((p) => p.id),
    },
    realized: outcomes.reduce((total, o) => total + o.actual_revenue, 0),
    outcomeRows: outcomes.length,
    outcomeProposals: byProposal.size,
    totalProposals: proposals.length,
  }
}

export interface RevenueModelSlice {
  model: RevenueModel
  label: string
  count: number
  upside: number
  realized: number
}

export interface RevenueModelMix {
  /** Only models actually used, busiest first. Never zero-filled from REVENUE_MODELS. */
  slices: RevenueModelSlice[]
  classified: number
  unclassified: number
  total: number
}

/**
 * Grouped by revenue model, counting only proposals that state one.
 *
 * Rendering all eight models with a zero would imply eight measurements were made when only the
 * used ones are measurements -- the same reason a null model renders a dash on the Proposals page
 * rather than being bucketed as "other".
 */
export function revenueModelMix(proposals: ProposalRow[], outcomes: OutcomeRow[]): RevenueModelMix {
  const byProposal = groupOutcomes(outcomes)
  const byModel = new Map<RevenueModel, RevenueModelSlice>()

  for (const proposal of proposals) {
    const model = proposal.revenue_model
    if (!model) continue
    const slice = byModel.get(model) ?? {
      model,
      label: revenueModelLabel(model) ?? model,
      count: 0,
      upside: 0,
      realized: 0,
    }
    slice.count += 1
    slice.upside += proposal.expected_upside
    slice.realized += sumRevenue(byProposal.get(proposal.id))
    byModel.set(model, slice)
  }

  const slices = [...byModel.values()].sort((a, b) => b.count - a.count || b.upside - a.upside)
  const classified = slices.reduce((total, s) => total + s.count, 0)

  return { slices, classified, unclassified: proposals.length - classified, total: proposals.length }
}

export interface MonetizationCoverage {
  total: number
  withBlock: number
  /** monetization_json IS NULL -- filed before the column existed. */
  predateField: number
  /** Present but unparseable. Counted apart, or the table's row count won't reconcile. */
  unreadable: number
}

export function monetizationCoverage(proposals: ProposalRow[]): MonetizationCoverage {
  let withBlock = 0
  let predateField = 0
  let unreadable = 0

  for (const proposal of proposals) {
    if (!proposal.monetization_json) predateField += 1
    else if (parseMonetization(proposal)) withBlock += 1
    else unreadable += 1
  }

  return { total: proposals.length, withBlock, predateField, unreadable }
}

/** Flat on purpose: exportCsv's column keys have to index the row type directly. */
export interface ProspectRow extends Monetization {
  id: number
  domain: string
  description: string
  status: ProposalRow['status']
  revenueModel: RevenueModel | null
  revenueModelText: string
  expectedUpside: number
  /** Summed across every outcome row; null when the proposal has none. */
  actualRevenue: number | null
  evidence: ExecutionEvidence
  stepCount: number
  humanStepCount: number
  /** Days since decided_at, or null when it was never decided. */
  daysSinceDecision: number | null
  /** Past the day count the proposal itself stated, with nothing realized. */
  pastOwnDeadline: boolean
}

export function buildProspectRows(
  proposals: ProposalRow[],
  outcomes: OutcomeRow[],
  now: number = Date.now(),
): ProspectRow[] {
  const byProposal = groupOutcomes(outcomes)
  const rows: ProspectRow[] = []

  for (const proposal of proposals) {
    const monetization = parseMonetization(proposal)
    if (!monetization) continue

    const steps = parseSteps(proposal)
    const outcomeRows = byProposal.get(proposal.id)
    const actualRevenue = outcomeRows ? sumRevenue(outcomeRows) : null
    const daysSinceDecision = proposal.decided_at
      ? Math.floor((now - new Date(proposal.decided_at).getTime()) / DAY_MS)
      : null

    rows.push({
      ...monetization,
      id: proposal.id,
      domain: proposal.domain,
      description: proposal.description,
      status: proposal.status,
      revenueModel: proposal.revenue_model,
      revenueModelText: revenueModelLabel(proposal.revenue_model) ?? '',
      expectedUpside: proposal.expected_upside,
      actualRevenue,
      evidence: executionEvidence(proposal, byProposal),
      stepCount: steps.length,
      humanStepCount: steps.filter((s) => s.owner === 'human').length,
      daysSinceDecision,
      pastOwnDeadline:
        daysSinceDecision !== null &&
        daysSinceDecision > monetization.daysToFirstDollar &&
        (actualRevenue ?? 0) === 0,
    })
  }

  return rows
}

/** Fixed edges, not data-derived quantiles -- moving edges make two readings incomparable. */
const FIRST_DOLLAR_BUCKETS: { label: string; max: number }[] = [
  { label: '≤ 7 days', max: 7 },
  { label: '8–30 days', max: 30 },
  { label: '31–90 days', max: 90 },
  { label: '> 90 days', max: Infinity },
]

export interface FirstDollarStats {
  n: number
  /** Sorted ascending. Printed verbatim when n is too small for a median to mean anything. */
  values: number[]
  median: number | null
  min: number | null
  max: number | null
  buckets: { label: string; count: number }[]
  pastOwnDeadline: number
}

/**
 * Median rather than mean -- n is single digits for a long time here, and one 365-day proposal
 * would drag a mean over a handful of 14-day ones. Below four values there is no median at all:
 * a median of two numbers is an invented midpoint and a median of one is that number wearing a
 * statistic's hat, so the caller lists the raw values instead.
 */
export function firstDollarStats(rows: ProspectRow[]): FirstDollarStats {
  const values = rows.map((r) => r.daysToFirstDollar).sort((a, b) => a - b)

  let median: number | null = null
  if (values.length >= 4) {
    const mid = Math.floor(values.length / 2)
    median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2
  }

  return {
    n: values.length,
    values,
    median,
    min: values.length ? values[0] : null,
    max: values.length ? values[values.length - 1] : null,
    buckets: FIRST_DOLLAR_BUCKETS.map((bucket, index) => {
      const floor = index === 0 ? -Infinity : FIRST_DOLLAR_BUCKETS[index - 1].max
      return { label: bucket.label, count: values.filter((v) => v > floor && v <= bucket.max).length }
    }),
    pastOwnDeadline: rows.filter((r) => r.pastOwnDeadline).length,
  }
}
