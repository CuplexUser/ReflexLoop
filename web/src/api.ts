import { authHeaders } from './auth'
import type {
  BuildQueue,
  ActionRow,
  ActionWithProposal,
  ControlState,
  DuplicateNotePair,
  EconomicsResponse,
  GoalHealth,
  GoalLandscape,
  GoalRow,
  GoalStatus,
  LessonRow,
  OutcomeRow,
  PersistedEvent,
  Priority,
  ProposalRow,
  ReportDetail,
  ReportListRow,
  ReportRow,
  ReportVerdict,
  ResearchNoteRow,
  RunRow,
  SearchHit,
  SettingView,
  SettingsResponse,
  StatusResponse,
  ConnectorStatus,
} from './types'

export interface ScheduleOptions {
  priority?: Priority
  scheduledAt?: string | null
  recurrenceMs?: number | null
}

/** A human's rewrite of an idea, applied server-side just before approval. */
export interface ScopeEdits {
  editedDescription?: string
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
  connectors: () => getJson<ConnectorStatus[]>('/api/connectors'),
  settings: () => getJson<SettingsResponse>('/api/settings'),
  /** Applies a patch atomically -- the server rejects the whole thing if any value is bad. */
  saveSettings: (patch: Record<string, string | number>) =>
    send<{ ok: true; settings: SettingView[] }>('/api/settings', 'POST', patch),
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
  reports: (filter: { goalId?: number; verdict?: ReportVerdict } = {}) => {
    const params = new URLSearchParams()
    if (filter.goalId !== undefined) params.set('goalId', String(filter.goalId))
    if (filter.verdict) params.set('verdict', filter.verdict)
    const qs = params.toString()
    return getJson<ReportListRow[]>(`/api/reports${qs ? `?${qs}` : ''}`)
  },
  report: (id: number) => getJson<ReportDetail>(`/api/reports/${id}`),
  proposalReports: (id: number) => getJson<ReportRow[]>(`/api/proposals/${id}/reports`),
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

  cancelSchedule: (id: number) => send(`/api/proposals/${id}/cancel-schedule`, 'POST'),

  /**
   * Put an approved idea back in the deep-dive queue: a retry after an unfinished deep dive, or
   * a fresh report beside an existing one. The scheduler picks it up within ~15s.
   */
  rerunDeepDive: (id: number) => send<{ ok: true; proposal: ProposalRow }>(`/api/proposals/${id}/rerun`, 'POST'),

  /** Which deep dive is running, what is queued behind it, what is due later, and how long one takes. */
  queue: () => getJson<BuildQueue>('/api/queue'),

  // ---- memory curation ----
  editLesson: (id: number, fields: { domain?: string; lesson?: string }) => send(`/api/lessons/${id}`, 'PATCH', fields),
  muteLesson: (id: number, muted: boolean) => send(`/api/lessons/${id}/mute`, 'POST', { muted }),
  deleteLesson: (id: number) => send(`/api/lessons/${id}`, 'DELETE'),
  deleteResearchNote: (id: number) => send(`/api/research-notes/${id}`, 'DELETE'),
  mergeResearchNotes: (keepId: number, mergeIds: number[]) =>
    send('/api/research-notes/merge', 'POST', { keepId, mergeIds }),

  // ---- goals ----
  // Accepting a suggestion is its own endpoint rather than a status PATCH: it applies the
  // operator's edits and the activation in one call, so a goal is never briefly active carrying
  // text they were still correcting.
  goals: () => getJson<{ goals: GoalRow[]; health: GoalHealth[] }>('/api/goals'),
  goalLandscape: (id: number) => getJson<GoalLandscape>(`/api/goals/${id}/landscape`),
  createGoal: (fields: { title: string; brief?: string; weight?: number }) =>
    send<{ ok: true; id: number; control: ControlState }>('/api/goals', 'POST', fields),
  updateGoal: (id: number, fields: { title?: string; brief?: string; status?: GoalStatus; weight?: number }) =>
    send<{ ok: true; control: ControlState }>(`/api/goals/${id}`, 'PATCH', fields),
  acceptGoal: (id: number, edits?: { title?: string; brief?: string }) =>
    send<{ ok: true; control: ControlState }>(`/api/goals/${id}/accept`, 'POST', edits ?? {}),
  dismissGoal: (id: number) => send<{ ok: true; control: ControlState }>(`/api/goals/${id}/dismiss`, 'POST'),
  deleteGoal: (id: number) => send<{ ok: true; control: ControlState }>(`/api/goals/${id}`, 'DELETE'),

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
