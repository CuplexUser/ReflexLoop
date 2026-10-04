export type Priority = 'low' | 'normal' | 'high' | 'urgent'

export type RevenueModel =
  | 'affiliate'
  | 'subscription'
  | 'one_off'
  | 'ads'
  | 'marketplace'
  | 'service'
  | 'lead_gen'
  | 'sponsorship_donations'
  | 'open_core'
  | 'deferred'
  | 'other'

/** How an idea earns, as research had to state it before the idea could be filed. */
export interface Monetization {
  whoPays: string
  pricePoint: string
  pathToFirstDollar: string
  daysToFirstDollar: number
  keyAssumption: string
  validationSignal: string
}

/**
 * One step in an idea's launch outline. `owner` and `tool` exist only on legacy build-mode
 * proposals, where agent-owned steps named the act-phase tool they needed.
 */
export interface ProposalStep {
  title: string
  owner?: 'agent' | 'human'
  tool?: string
  doneWhen: string
}

export type Confidence = 'low' | 'medium' | 'high'

/** The research phase's read on an idea's market, filed with the idea and checked by its deep dive. */
export interface MarketAssessment {
  marketSize: string
  demandEvidence: { claim: string; sourceUrl: string }[]
  competitors: { name: string; url?: string; pricing?: string; gap?: string }[]
  keyRisks: string[]
  viabilityScore: number
  confidence: Confidence
}

export type ReportVerdict = 'pursue' | 'maybe' | 'drop'

export interface ReportSource {
  title: string
  url: string
  note?: string
}

/** A report without its body -- what lists and the ideas table carry. */
export interface ReportSummary {
  id: number
  proposal_id: number
  verdict: ReportVerdict
  viability_score: number
  confidence: Confidence
  summary: string
  created_at: string
}

export interface ReportListRow extends ReportSummary {
  goal_id: number | null
  proposal_domain: string
  proposal_description: string
  goal_title: string | null
}

/** A deep dive's full feasibility report. */
export interface ReportRow extends ReportSummary {
  goal_id: number | null
  /** Markdown. */
  body: string
  sources: ReportSource[]
}

export interface ReportDetail extends ReportRow {
  proposal_domain: string | null
  proposal_description: string | null
  goal_title: string | null
}

export interface ProposalRow {
  id: number
  domain: string
  description: string
  expected_cost: number
  expected_time_hours: number
  expected_upside: number
  /** Legacy build-mode tool fence, comma-separated. Empty on every research-mode idea. */
  required_tools: string
  status: 'pending' | 'approved' | 'rejected'
  /** On a rejection, the reason; on an approval, the operator's focus questions for the deep dive. */
  human_notes: string | null
  created_at: string
  decided_at: string | null
  /** Legacy: a human's verdict on a build-mode deliverable. Nothing sets it any more. */
  review_status: 'mvp_done' | 'needs_refinement' | null
  /** Set by the human at approval time -- never by the model. */
  priority: Priority
  scheduled_at: string | null
  recurrence_ms: number | null
  /** Orchestrator-maintained: when this idea's deep dive is next due, or null if nothing is pending. */
  next_run_at: string | null
  /** Legacy: set when a human edited a build-mode fence at approval time. */
  original_required_tools: string | null
  /** Set when a human edited the description at approval time -- what the model originally wrote. */
  original_description: string | null
  /** How the deep dive (or, on legacy rows, the build) went. Null until it has run at all. */
  act_status: 'running' | 'interrupted' | 'complete' | 'incomplete' | null
  /** JSON-encoded string[] of what the verifier objected to; null when it had no objections. */
  act_problems: string | null
  /** All three are null on proposals written before the monetization block existed. */
  revenue_model: RevenueModel | null
  /** JSON-encoded {@link Monetization} -- parse with parseMonetization in MonetizationBlock. */
  monetization_json: string | null
  /** JSON-encoded {@link ProposalStep}[] -- parse with parseSteps in MonetizationBlock. */
  steps_json: string | null
  /** JSON-encoded {@link MarketAssessment}. Null on legacy build-mode proposals. */
  market_json: string | null
  /** Attached by GET /api/proposals: the newest deep-dive report's summary, if any. */
  latest_report?: ReportSummary | null
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
  goal_id: number | null
  /** gap / demand / market_size / competitor / pricing / risk / saturated / ...; null on legacy rows. */
  kind: string | null
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
  /** Legacy: proposals that ran a build-mode act phase. */
  shipped: number
  /** Ideas with at least one deep-dive report. */
  deep_dives: number
  outcomes: number
  successes: number
  api_spend: number
  last_proposal_at: string | null
  /** Research cycles since this goal last produced a proposal — the "is this lane dead?" number. */
  empty_cycles: number
}

/** Where a setting's current value came from -- see src/settings.ts for the precedence. */
export type SettingSource = 'database' | 'environment' | 'default'

export interface SettingView {
  key: string
  label: string
  help: string
  group: 'loop' | 'search' | 'model' | 'fallback'
  type: 'integer' | 'string' | 'enum'
  /** The env var this seeds from, and what an operator would have edited before. */
  envVar: string
  options?: string[]
  min?: number
  max?: number
  /** True when '' is meaningful -- a per-phase override that inherits the base setting. */
  allowsEmpty?: boolean
  value: string | number
  source: SettingSource
}

export interface ProviderInfo {
  id: string
  label: string
  /** Whether this provider's key is present in .env. Keys deliberately never moved to the DB. */
  hasKey: boolean
  apiKeyEnv: string
  modelsUrl: string
}

export interface SettingsResponse {
  settings: SettingView[]
  providers: ProviderInfo[]
  searchKeys: { tavily: boolean; brave: boolean }
}

/** A declarative connector (src/connectors/defs/*.json) and whether its key is set. */
export interface ConnectorStatus {
  id: string
  label: string
  configured: boolean
  envVar: string | null
  docsUrl: string | null
  operations: { name: string; toolName: string; risk: 'read'; description: string }[]
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
  | { type: 'domains_changed'; domains: string[] }
  | { type: 'phase_start'; phase: string; proposalId: number | null }
  | { type: 'tool_call'; phase: string; proposalId: number | null; toolName: string; input: unknown }
  | { type: 'model_text'; phase: string; proposalId: number | null; text: string }
  | { type: 'phase_done'; phase: string; proposalId: number | null; costUsd: number; durationMs: number }
  | { type: 'llm_failover'; phase: string; proposalId: number | null; from: string; to: string; error: string }
  | { type: 'proposal_pending'; proposal: ProposalRow }
  | { type: 'proposal_decided'; proposal: ProposalRow }
  | { type: 'proposal_scheduled'; proposal: ProposalRow }
  | { type: 'scheduled_run_starting'; proposal: ProposalRow }
  /** Legacy: build-mode act phases recorded outcomes. Kept so old feed entries still render. */
  | { type: 'outcome_recorded'; proposalId: number }
  | { type: 'report_submitted'; proposalId: number; reportId: number; verdict: string; viabilityScore: number }
  | { type: 'lesson_saved'; domain: string }
  | { type: 'no_proposal'; reason: string; toolCalls: number }
  | {
      type: 'act_incomplete'
      proposalId: number
      problems: string[]
      toolCalls: number
      stopReason: string
      providerStopReason?: string
    }
  | { type: 'reflect_incomplete'; proposalId: number; toolCalls: number }
  | { type: 'goal_suggested'; goalId: number; title: string; rationale: string }
  | { type: 'cycle_idle'; nextCycleAt: string }

/** One entry in the deep-dive queue. (Named from build mode; the shape is unchanged.) */
export interface QueuedBuild {
  proposalId: number
  domain: string
  description: string
  priority: Priority
  nextRunAt: string | null
  actStatus: ProposalRow['act_status']
  recurrenceMs: number | null
}

/** Duration stats over recent deep dives. Null fields mean there is no history to forecast from. */
export interface DurationForecast {
  samples: number
  medianMs: number | null
  minMs: number | null
  maxMs: number | null
}

export interface BuildQueue {
  running: (QueuedBuild & { startedAt: string | null; model: string | null }) | null
  queued: QueuedBuild[]
  /** Approved and due later — the scheduler hands these to the worker when their time comes. */
  scheduled: QueuedBuild[]
  /** Approved, no report, and nothing will run it: awaiting a deliberate retry. */
  stalled: QueuedBuild[]
  /** Scoped to the pinned deep-dive model when there is one. */
  forecast: DurationForecast
  forecastAllModels: DurationForecast
}

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

/** One goal's market landscape -- GET /api/goals/:id/landscape. */
export interface GoalLandscape {
  goal: GoalRow
  health: GoalHealth | null
  notes: { kind: string; notes: ResearchNoteRow[] }[]
  ideas: { proposal: ProposalRow; market: MarketAssessment | null; report: ReportSummary | null }[]
  competitors: { name: string; url?: string; pricing?: string; gap?: string; ideaIds: number[] }[]
  counts: { notes: number; ideas: number; pursue: number; maybe: number; drop: number }
}
