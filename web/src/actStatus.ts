import type { ProposalRow } from './types'

export type ActStatus = NonNullable<ProposalRow['act_status']>

/**
 * Deep-dive states (stored as `act_status`) that mean no report came out of it, mapped to what
 * the operator should make of each. Keyed for a plain lookup so `null` (never run) and
 * `complete` fall through to nothing -- neither is a problem to surface.
 */
export const UNFINISHED_ACT: Record<string, string> = {
  running: 'This deep dive is running right now.',
  interrupted:
    'The process stopped mid-investigation, so no report came out of it. A hard stop resumes it automatically; after a graceful one, re-run it from here.',
  incomplete:
    'The deep dive ended without submitting a report. Re-running it starts a fresh investigation.',
}

/** Whether a deep dive can be dispatched again: an approved idea that isn't being investigated right now. */
export function canRerun(proposal: Pick<ProposalRow, 'status' | 'act_status'>): boolean {
  return proposal.status === 'approved' && proposal.act_status !== 'running'
}

/**
 * The confirmation a re-run has to pass first, or null when it needs none.
 *
 * Only a **finished** deep dive gets one: nothing it does has side effects, but it does cost
 * model spend, and a second report is only worth paying for if something has changed.
 * `interrupted` / `incomplete` / never-run pass straight through -- there the point of the
 * button is that the report is missing.
 */
export function rerunConfirm(
  actStatus: ActStatus | null
): { title: string; content: string; okText: string } | null {
  if (actStatus !== 'complete') return null
  return {
    title: 'Run another deep dive?',
    content:
      'This idea already has a report. Running the deep dive again costs model spend and files a new report beside the existing one, which is kept.',
    okText: 'Run it again',
  }
}

/** What the re-run button should say: a retry when the report is missing, a refresh when it isn't. */
export function rerunLabel(actStatus: ActStatus | null): string {
  if (actStatus === 'interrupted' || actStatus === 'incomplete') return 'Retry deep dive'
  if (actStatus === 'complete') return 'Run deep dive again'
  return 'Run deep dive now'
}
