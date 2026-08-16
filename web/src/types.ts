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
  /** Set only when a human edited the scope at approval time -- what the model originally asked for. */
  original_required_tools: string | null
  original_description: string | null
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
  /** 1 = excluded from the agent's lesson_search. Human-set; the model can't mute itself. */
  muted: number
  /** Set when a human rewrote the text. */
  edited_at: string | null
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

export type ArtifactKind = 'site' | 'repo' | 'pull_request'
export type ArtifactProvider = 'github' | 'vercel' | 'netlify'

/** One reachable thing an approved proposal produced -- a repo, a deployment, a PR. */
export interface DeliverableArtifact {
  kind: ArtifactKind
  provider: ArtifactProvider
  label: string
  url: string
  /** "production" / "preview" / "merged" / "open", when the artifact has one. */
  detail: string | null
  occurredAt: string
  actionId: number
}

/** What one approved proposal actually built, derived server-side from its act-phase actions. */
export interface Deliverable {
  proposalId: number
  domain: string
  description: string
  name: string | null
  reviewStatus: 'mvp_done' | 'needs_refinement' | null
  priority: Priority
  artifacts: DeliverableArtifact[]
  siteUrl: string | null
  repoUrl: string | null
  filesCommitted: number
  commits: number
  actionCount: number
  startedAt: string
  lastActivityAt: string
  outcome: { success: boolean; revenue: number; cost: number; notes: string | null; recordedAt: string } | null
}

export interface StatusResponse {
  domains: string[]
  totalCostUsd: number
  control: ControlState
  authRequired: boolean
  /**
   * The backend is `npm run start:console`: the database is open read-only and every write
   * is refused except domains, cycle interval and pause. Drives `useConsoleOnly()`, which
   * disables the affordances this backend would reject.
   */
  consoleOnly: boolean
}

export interface ControlState {
  paused: boolean
  /** Every goal, whatever its status — including suggested ones, which the loop never researches. */
  goals: GoalSummary[]
  /** Titles of the active goals only. Derived from `goals` server-side, never set independently. */
  domains: string[]
  cycleIntervalMs: number
  directive: string | null
  runningProposalId: number | null
  queuedProposalIds: number[]
}

export type GoalStatus = 'active' | 'paused' | 'retired' | 'suggested'

export interface GoalSummary {
  id: number
  title: string
  brief: string
  status: GoalStatus
  weight: number
}

/** Rows are passed through from SQLite as-is, hence snake_case — same as LessonRow and friends. */
export interface GoalRow extends GoalSummary {
  /** 'agent' means it arrived via goal_suggest and is inert until a human accepts it. */
  origin: 'human' | 'agent'
  parent_id: number | null
  /** Why the agent suggested it — only set for agent-origin goals. */
  rationale: string | null
  created_at: string
  updated_at: string
}

/** Per-goal counters derived on read, so they can't disagree with the proposal and run logs. */
export interface GoalHealth {
  goal_id: number
  title: string
  status: GoalStatus
  weight: number
  proposals: number
  approved: number
  shipped: number
  outcomes: number
  successes: number
  api_spend: number
  last_proposal_at: string | null
  /** Research cycles since this goal last produced a proposal — the "is this lane dead?" number. */
  empty_cycles: number
}

/** How much damage a tool can do -- drives the risk badges on a proposal under review. */
export type ToolRisk = 'write' | 'read' | 'memory' | 'unknown'

export interface ToolInfo {
  name: string
  risk: ToolRisk
}

export interface SearchHit {
  type: 'proposal' | 'lesson' | 'research_note' | 'action'
  id: number
  title: string
  snippet: string
  badge?: string
  proposalId?: number
}

export interface PhaseSpend {
  phase: string
  runs: number
  cost_usd: number
  duration_ms: number
}

export interface DaySpend {
  day: string
  cost_usd: number
  runs: number
}

export interface DomainScore {
  domain: string
  proposals: number
  approved: number
  outcomes: number
  successes: number
  revenue: number
  reported_cost: number
  /** Sum of expected_upside across proposals that produced an outcome -- compare against `revenue`. */
  forecast_upside: number
  api_spend: number
}

/** Lifetime spend on one provider/model. Both are null for runs predating those columns. */
export interface ModelSpend {
  provider: string | null
  model: string | null
  runs: number
  cost_usd: number
  first_at: string
  last_at: string
}

export interface EconomicsResponse {
  spendByPhase: PhaseSpend[]
  spendByModel: ModelSpend[]
  spendOverTime: DaySpend[]
  domains: DomainScore[]
  totalCostUsd: number
  /** Spend on runs charged to no proposal (research/plan) -- the domain table can't show it. */
  unattributedSpend: number
}

export interface DuplicateNotePair {
  a: ResearchNoteRow
  b: ResearchNoteRow
  similarity: number
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
  | { type: 'no_proposal'; reason: string; toolCalls: number }
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
