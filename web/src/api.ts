import { authHeaders } from './auth'
import type {
  ActionRow,
  ActionWithProposal,
  ControlState,
  DuplicateNotePair,
  EconomicsResponse,
  LessonRow,
  OutcomeRow,
  PersistedEvent,
  Priority,
  ProposalRow,
  ResearchNoteRow,
  RunRow,
  SearchHit,
  StatusResponse,
  ToolInfo,
} from './types'

export interface ScheduleOptions {
  priority?: Priority
  scheduledAt?: string | null
  recurrenceMs?: number | null
}

/** Human edits to a proposal's scope, applied server-side just before approval. */
export interface ScopeEdits {
  editedDescription?: string
  editedRequiredTools?: string[]
}

/** Thrown for a 401 so the UI can prompt for the token instead of showing a generic failure. */
export class UnauthorizedError extends Error {
  constructor() {
    super('API token required or invalid')
    this.name = 'UnauthorizedError'
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders() })
  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

async function send<T = { ok: true }>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(payload.error ?? `${path} -> ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  status: () => getJson<StatusResponse>('/api/status'),
  tools: () => getJson<ToolInfo[]>('/api/tools'),
  proposals: () => getJson<ProposalRow[]>('/api/proposals'),
  proposalActions: (id: number) => getJson<ActionRow[]>(`/api/proposals/${id}/actions`),
  proposalRuns: (id: number) => getJson<RunRow[]>(`/api/proposals/${id}/runs`),
  outcomes: () => getJson<OutcomeRow[]>('/api/outcomes'),
  lessons: () => getJson<LessonRow[]>('/api/lessons'),
  researchNotes: () => getJson<ResearchNoteRow[]>('/api/research-notes'),
  duplicateNotes: () => getJson<DuplicateNotePair[]>('/api/research-notes/duplicates'),
  runs: () => getJson<RunRow[]>('/api/runs'),
  economics: () => getJson<EconomicsResponse>('/api/economics'),
  events: () => getJson<PersistedEvent[]>('/api/events'),
  actions: () => getJson<ActionWithProposal[]>('/api/actions'),
  search: (q: string) => getJson<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),

  decide: (id: number, approved: boolean, notes?: string, schedule?: ScheduleOptions, edits?: ScopeEdits) =>
    send(`/api/proposals/${id}/decision`, 'POST', { approved, notes, ...schedule, ...edits }),

  bulkDecide: (ids: number[], approved: boolean, notes?: string, priority?: Priority) =>
    send<{ ok: true; decided: number[]; skipped: number[] }>('/api/proposals/bulk-decision', 'POST', {
      ids,
      approved,
      notes,
      priority,
    }),

  setProposalReview: (id: number, reviewStatus: ProposalRow['review_status']) =>
    send(`/api/proposals/${id}/review`, 'POST', { reviewStatus }),

  cancelSchedule: (id: number) => send(`/api/proposals/${id}/cancel-schedule`, 'POST'),
  /**
   * Narrow or widen an already-approved proposal's scope, up until its act phase starts.
   * Pending proposals use `decide` instead, which applies edits before the status flips.
   * 409s once the proposal is running or has acted.
   */
  editScope: (id: number, edits: { description?: string; requiredTools?: string[] }) =>
    send<{ ok: true; proposal: ProposalRow }>(`/api/proposals/${id}/scope`, 'POST', edits),

  // ---- memory curation ----
  editLesson: (id: number, fields: { domain?: string; lesson?: string }) => send(`/api/lessons/${id}`, 'PATCH', fields),
  muteLesson: (id: number, muted: boolean) => send(`/api/lessons/${id}/mute`, 'POST', { muted }),
  deleteLesson: (id: number) => send(`/api/lessons/${id}`, 'DELETE'),
  deleteResearchNote: (id: number) => send(`/api/research-notes/${id}`, 'DELETE'),
  mergeResearchNotes: (keepId: number, mergeIds: number[]) =>
    send('/api/research-notes/merge', 'POST', { keepId, mergeIds }),

  // ---- runtime control ----
  control: () => getJson<ControlState>('/api/control'),
  setPaused: (paused: boolean) => send<{ ok: true; control: ControlState }>('/api/control/pause', 'POST', { paused }),
  runNow: () => send('/api/control/run-now', 'POST'),
  abort: (proposalId?: number) => send('/api/control/abort', 'POST', { proposalId }),
  setDomains: (domains: string[]) =>
    send<{ ok: true; control: ControlState }>('/api/control/domains', 'POST', { domains }),
  setInterval: (cycleIntervalMs: number) =>
    send<{ ok: true; control: ControlState }>('/api/control/interval', 'POST', { cycleIntervalMs }),
  setDirective: (directive: string | null) =>
    send<{ ok: true; control: ControlState }>('/api/control/directive', 'POST', { directive }),
}
