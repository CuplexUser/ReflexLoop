// web/src/report.ts
//
// Labels and tag colors for deep-dive reports and the market block. Kept out of the component
// files so they export only components (fast refresh needs that).
//
// Tag colors are AntD preset names rather than palette values: a preset carries its own
// light/dark pair, which a raw color can't.

import type { Confidence, ReportVerdict } from './types'

export const VERDICT_LABEL: Record<ReportVerdict, string> = {
  pursue: 'Pursue',
  maybe: 'Maybe',
  drop: 'Drop',
}

export const VERDICT_TAG: Record<ReportVerdict, string> = {
  pursue: 'success',
  maybe: 'warning',
  drop: 'error',
}

export const VERDICTS = Object.keys(VERDICT_LABEL) as ReportVerdict[]

export const CONFIDENCE_TAG: Record<Confidence, string> = {
  low: 'default',
  medium: 'processing',
  high: 'blue',
}

/** A 1-5 score as a tag color: weak scores read as a warning, strong ones as good news. */
export function scoreTag(score: number): string {
  if (score >= 4) return 'success'
  if (score === 3) return 'gold'
  return 'default'
}
