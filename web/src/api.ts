import type {
  ActionRow,
  LessonRow,
  OutcomeRow,
  PersistedEvent,
  ProposalRow,
  ResearchNoteRow,
  RunRow,
  StatusResponse,
} from './types'

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

export const api = {
  status: () => getJson<StatusResponse>('/api/status'),
  proposals: () => getJson<ProposalRow[]>('/api/proposals'),
  proposalActions: (id: number) => getJson<ActionRow[]>(`/api/proposals/${id}/actions`),
  outcomes: () => getJson<OutcomeRow[]>('/api/outcomes'),
  lessons: () => getJson<LessonRow[]>('/api/lessons'),
  researchNotes: () => getJson<ResearchNoteRow[]>('/api/research-notes'),
  runs: () => getJson<RunRow[]>('/api/runs'),
  events: () => getJson<PersistedEvent[]>('/api/events'),

  async decide(id: number, approved: boolean, notes?: string): Promise<void> {
    const res = await fetch(`/api/proposals/${id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved, notes }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? `Decision failed: ${res.status}`)
    }
  },
}
