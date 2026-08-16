import { useEffect, useRef } from 'react'
import { Empty, Typography } from 'antd'
import type { AgentEvent, FeedEntry } from '../types'
import { PHASE_LABEL, preview } from '../format'
import { palette } from '../theme'

function lineColor(type: AgentEvent['type']): string {
  switch (type) {
    case 'proposal_pending':
    case 'no_proposal':
      return palette.pending
    // Not `pending` — an act phase that stopped partway through approved work is the one
    // thing in this feed the operator has to act on, and it used to look like a clean finish.
    case 'act_incomplete':
      return palette.rejected
    case 'proposal_decided':
    case 'phase_done':
    case 'outcome_recorded':
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
    case 'proposal_pending':
      return `⚠ proposal #${event.proposal.id} awaiting review — ${preview(event.proposal.description, 140)}`
    case 'proposal_decided':
      return `${event.proposal.status === 'approved' ? '✓' : '✗'} proposal #${event.proposal.id} ${event.proposal.status}`
    case 'outcome_recorded':
      return `$ outcome recorded for proposal #${event.proposalId}`
    case 'lesson_saved':
      return `◆ lesson saved — domain: ${event.domain}`
    case 'no_proposal':
      // Zero tool calls means the phase never researched anything -- that's a failed run
      // dressed up as a quiet one, and it should not read like a considered decision.
      return event.toolCalls === 0
        ? `✗ no proposal — the research phase ran no tools and returned nothing; the model call likely failed`
        : `○ no proposal this cycle (${event.toolCalls} tool calls) — ${preview(event.reason, 300)}`
    case 'act_incomplete':
      // Spelled out rather than summarised: every entry here is a step of the approved plan
      // that never ran, and the operator has to decide what to do about each one.
      return `✗ proposal #${event.proposalId} act phase INCOMPLETE (${event.toolCalls} tool calls, ${event.stopReason}) — ${event.problems.join(' ')}`
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
