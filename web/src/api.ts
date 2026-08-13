import type {
  ActionRow,
  ActionWithProposal,
  LessonRow,
  OutcomeRow,
  PersistedEvent,
  Priority,
  ProposalRow,
  ResearchNoteRow,
  RunRow,
  StatusResponse,
} from './types'

export interface ScheduleOptions {
  priority?: Priority
  scheduledAt?: string | null
  recurrenceMs?: number | null
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

export const api = {
  status: () => getJson<StatusResponse>('/api/status'),
  proposals: () => getJson<ProposalRow[]>('/api/proposals'),
  proposalActions: (id: number) => getJson<ActionRow[]>(`/api/proposals/${id}/actions`),
  proposalRuns: (id: number) => getJson<RunRow[]>(`/api/proposals/${id}/runs`),
  outcomes: () => getJson<OutcomeRow[]>('/api/outcomes'),
  lessons: () => getJson<LessonRow[]>('/api/lessons'),
  researchNotes: () => getJson<ResearchNoteRow[]>('/api/research-notes'),
  runs: () => getJson<RunRow[]>('/api/runs'),
  events: () => getJson<PersistedEvent[]>('/api/events'),
  actions: () => getJson<ActionWithProposal[]>('/api/actions'),

  async decide(id: number, approved: boolean, notes?: string, schedule?: ScheduleOptions): Promise<void> {
    const res = await fetch(`/api/proposals/${id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved, notes, ...schedule }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? `Decision failed: ${res.status}`)
    }
  },

  async setProposalReview(id: number, reviewStatus: ProposalRow['review_status']): Promise<void> {
    const res = await fetch(`/api/proposals/${id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewStatus }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? `Review update failed: ${res.status}`)
    }
  },

  async cancelSchedule(id: number): Promise<void> {
    const res = await fetch(`/api/proposals/${id}/cancel-schedule`, { method: 'POST' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? `Cancel schedule failed: ${res.status}`)
    }
  },
}
