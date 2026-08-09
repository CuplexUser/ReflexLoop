import { useEffect, useRef } from 'react'
import { Empty, Typography } from 'antd'
import type { AgentEvent, FeedEntry } from '../types'
import { PHASE_LABEL, preview } from '../format'
import { palette } from '../theme'

function lineColor(type: AgentEvent['type']): string {
  switch (type) {
    case 'proposal_pending':
      return palette.pending
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
        background: '#0D0F14',
        border: '1px solid #262B35',
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
            <span style={{ color: '#5B6272', flexShrink: 0 }}>{new Date(at).toLocaleTimeString()}</span>
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{renderLine(event)}</span>
          </div>
        ))
      )}
    </div>
  )
}
