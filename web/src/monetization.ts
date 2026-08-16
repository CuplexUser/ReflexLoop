// web/src/monetization.ts
//
// Parsing and labelling for the monetization block a proposal carries. Kept out of
// MonetizationBlock.tsx so that file exports only components (fast refresh needs that),
// and because the proposals table uses these without rendering the block at all.

import type { Monetization, ProposalRow, ProposalStep, RevenueModel } from './types'

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
