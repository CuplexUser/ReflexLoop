import { useEffect, useRef } from 'react'
import { Empty, Typography } from 'antd'
import type { AgentEvent, FeedEntry } from '../types'
import { PHASE_LABEL, preview } from '../format'
import { palette } from '../theme'

function lineColor(type: AgentEvent['type']): string {
  switch (type) {
    case 'proposal_pending':
    case 'no_proposal':
    case 'llm_failover':
      return palette.pending
    // Not `pending` — a deep dive that ended without a report is the one thing in this feed
    // the operator has to act on, and it would otherwise look like a clean finish.
    case 'act_incomplete':
    case 'reflect_incomplete':
      return palette.rejected
    case 'proposal_decided':
    case 'phase_done':
    case 'outcome_recorded':
    case 'report_submitted':
    case 'lesson_saved':
      return palette.approved
    case 'run_started':
    case 'phase_start':
      return palette.active
    default:
      return palette.textMuted
  }
}

function renderLine(event: AgentEvent): string {
  const phaseTag = 'phase' in event ? `[${PHASE_LABEL[event.phase] ?? event.phase}] ` : ''
  switch (event.type) {
    case 'run_started':
      return `● agent runner started — domains: ${event.domains.join(', ')}`
    case 'phase_start':
      return `${phaseTag}▸ started`
    case 'tool_call':
      return `${phaseTag}⚙ ${event.toolName} ${preview(event.input, 140)}`
    case 'model_text':
      return `${phaseTag}· ${preview(event.text, 220)}`
    case 'phase_done':
      return `${phaseTag}✓ done in ${(event.durationMs / 1000).toFixed(1)}s — $${event.costUsd.toFixed(4)}`
    case 'llm_failover':
      return `${phaseTag}⇄ ${event.from} failed, switched to ${event.to} — ${preview(event.error, 220)}`
    case 'proposal_pending':
      return `⚠ idea #${event.proposal.id} awaiting review — ${preview(event.proposal.description, 140)}`
    case 'proposal_decided':
      return `${event.proposal.status === 'approved' ? '✓' : '✗'} idea #${event.proposal.id} ${event.proposal.status}`
    case 'outcome_recorded':
      // Legacy: only build-mode act phases emitted this; kept so old feed entries still read.
      return `$ outcome recorded for proposal #${event.proposalId}`
    case 'report_submitted':
      return `▣ report #${event.reportId} on idea #${event.proposalId} — ${event.verdict}, viability ${event.viabilityScore}/5`
    case 'lesson_saved':
      return `◆ lesson saved — domain: ${event.domain}`
    case 'no_proposal':
      // Zero tool calls means the phase never researched anything -- that's a failed run
      // dressed up as a quiet one, and it should not read like a considered decision.
      return event.toolCalls === 0
        ? `✗ no idea — the research phase ran no tools and returned nothing; the model call likely failed`
        : `○ no new idea this cycle (${event.toolCalls} tool calls) — ${preview(event.reason, 300)}`
    case 'act_incomplete':
      // Spelled out rather than summarised: the operator decides whether to retry from what
      // went wrong. The event type is persisted, so it keeps its build-mode name.
      return `✗ idea #${event.proposalId} deep dive INCOMPLETE (${event.toolCalls} tool calls, ${event.stopReason}${
        event.providerStopReason ? `/${event.providerStopReason}` : ''
      }) — ${event.problems.join(' ')}`
    case 'reflect_incomplete':
      // Zero tool calls here specifically means lesson_search never ran -- the reflect prompt
      // requires it before anything else, so a phase that ended without it recorded nothing.
      return `✗ idea #${event.proposalId} reflect phase ended without calling lesson_search (${event.toolCalls} tool calls) — no lesson recorded`
    case 'cycle_idle':
      return `… idle until ${new Date(event.nextCycleAt).toLocaleTimeString()}`
    default:
      return JSON.stringify(event)
  }
}

export function LiveConsole({ feed, height = 420 }: { feed: FeedEntry[]; height?: number | string }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [feed.length])

  return (
    <div
      ref={scrollRef}
      className="mono"
      style={{
        height,
        overflowY: 'auto',
        background: palette.bgSunken,
        border: `1px solid ${palette.border}`,
        borderRadius: 8,
        padding: '12px 16px',
        fontSize: 13,
        lineHeight: 1.7,
      }}
    >
      {feed.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<Typography.Text type="secondary">Waiting for activity…</Typography.Text>}
          style={{ marginTop: 48 }}
        />
      ) : (
        feed.map(({ key, at, event }) => (
          <div key={key} style={{ display: 'flex', gap: 10, color: lineColor(event.type) }}>
            <span style={{ color: palette.textFaint, flexShrink: 0 }}>{new Date(at).toLocaleTimeString()}</span>
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{renderLine(event)}</span>
          </div>
        ))
      )}
    </div>
  )
}
