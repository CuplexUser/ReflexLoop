import type { ProposalRow } from './types'

export type ActStatus = NonNullable<ProposalRow['act_status']>

/**
 * Act-phase states that mean the work isn't finished, mapped to what the operator should make
 * of each. Keyed for a plain lookup so `null` (never acted) and `complete` fall through to
 * nothing — neither is a problem to surface.
 *
 * A repo existing is not the same as a build finishing: `github_create_repo` succeeding is
 * enough to produce a Deliverables card, which is how two empty repos came to look shipped.
 */
export const UNFINISHED_ACT: Record<string, string> = {
  running: 'This build is executing right now — what you see is partial.',
  interrupted:
    'The process stopped mid-build. Whatever had already landed is here; the rest never ran, and it was descheduled rather than re-run automatically so it could not repeat side effects.',
  incomplete:
    'The act phase ended without finishing the approved plan. Check the proposal for which steps never ran.',
}

/** Whether a build can be dispatched again: approved work that isn't currently executing. */
export function canRerun(proposal: Pick<ProposalRow, 'status' | 'act_status'>): boolean {
  return proposal.status === 'approved' && proposal.act_status !== 'running'
}

/**
 * What the "run build now" button should say. An unfinished build is a retry; a finished one is
 * a deliberate re-execution, and the label shouldn't pretend those are the same thing.
 */
export function rerunLabel(actStatus: ActStatus | null): string {
  if (actStatus === 'interrupted' || actStatus === 'incomplete') return 'Retry build'
  if (actStatus === 'complete') return 'Run build again'
  return 'Run build now'
}
