export type Priority = 'low' | 'normal' | 'high' | 'urgent'

export interface ProposalRow {
  id: number
  domain: string
  description: string
  expected_cost: number
  expected_time_hours: number
  expected_upside: number
  required_tools: string
  status: 'pending' | 'approved' | 'rejected'
  human_notes: string | null
  created_at: string
  decided_at: string | null
  /** Human-only verdict on the actual deliverable, set after the fact -- independent of outcome.success. */
  review_status: 'mvp_done' | 'needs_refinement' | null
  /** Set by the human at approval time -- never by the model. */
  priority: Priority
  scheduled_at: string | null
  recurrence_ms: number | null
  /** Orchestrator-maintained: when this proposal's act phase is next due, or null if nothing is pending. */
  next_run_at: string | null
}

export interface OutcomeRow {
  id: number
  proposal_id: number
  actual_revenue: number
  actual_cost: number
  actual_time_hours: number | null
  success: 0 | 1
  notes: string | null
  recorded_at: string
  proposal_description: string
  proposal_domain: string
}

export interface LessonRow {
  id: number
  domain: string
  lesson: string
  derived_from_outcome_id: number | null
  confidence: number
  times_reinforced: number
  times_contradicted: number
  created_at: string
  updated_at: string
}

export interface ResearchNoteRow {
  id: number
  topic: string
  finding: string
  source: string | null
  confidence: number | null
  fetched_at: string
}

export interface RunRow {
  id: number
  proposal_id: number | null
  phase: string
  cost_usd: number
  duration_ms: number | null
  started_at: string
}

export interface ActionRow {
  id: number
  proposal_id: number | null
  phase: string
  tool_name: string
  tool_input: string | null
  tool_output: string | null
  occurred_at: string
}

/** An action taken on an approved proposal, with the proposal's context and a browsable result URL if the tool produced one. */
export interface ActionWithProposal {
  id: number
  proposal_id: number
  phase: string
  tool_name: string
  tool_input: string | null
  tool_output: string | null
  occurred_at: string
  proposal_domain: string
  proposal_description: string
  result_url: string | null
}

export interface StatusResponse {
  domains: string[]
  totalCostUsd: number
}

export type Phase = 'research_plan' | 'act' | 'reflect'

export type AgentEvent =
  | { type: 'run_started'; domains: string[] }
  | { type: 'phase_start'; phase: string; proposalId: number | null }
  | { type: 'tool_call'; phase: string; proposalId: number | null; toolName: string; input: unknown }
  | { type: 'model_text'; phase: string; proposalId: number | null; text: string }
  | { type: 'phase_done'; phase: string; proposalId: number | null; costUsd: number; durationMs: number }
  | { type: 'proposal_pending'; proposal: ProposalRow }
  | { type: 'proposal_decided'; proposal: ProposalRow }
  | { type: 'proposal_scheduled'; proposal: ProposalRow }
  | { type: 'scheduled_run_starting'; proposal: ProposalRow }
  | { type: 'outcome_recorded'; proposalId: number }
  | { type: 'lesson_saved'; domain: string }
  | { type: 'cycle_idle'; nextCycleAt: string }

export interface FeedEntry {
  key: string
  at: number
  event: AgentEvent
}

/** An event as persisted server-side and returned by GET /api/events. */
export interface PersistedEvent {
  id: number
  occurredAt: string
  event: AgentEvent
}
