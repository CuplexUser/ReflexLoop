import type { CSSProperties } from 'react'
import { LinkOutlined } from '@ant-design/icons'
import { Modal, Space, Tag, Typography } from 'antd'
import type { ActionWithProposal } from '../types'
import { PHASE_LABEL, actionLabel } from '../format'

function prettyInput(raw: string | null): string {
  if (!raw) return '—'
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** tool_output is the raw PostToolUse response: an MCP content-block array whose
 * text is itself a JSON-stringified result -- unwrap both layers for display. */
function prettyOutput(raw: string | null): string {
  if (!raw) return '—'
  try {
    const content = JSON.parse(raw) as { type?: string; text?: string }[]
    const text = Array.isArray(content) ? content.find((c) => c?.type === 'text')?.text : undefined
    if (text === undefined) return JSON.stringify(JSON.parse(raw), null, 2)
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  } catch {
    return raw
  }
}

const codeBlockStyle: CSSProperties = {
  marginTop: 4,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  background: '#0D0F14',
  border: '1px solid #262B35',
  borderRadius: 8,
  padding: 12,
  fontSize: 12,
  maxHeight: 280,
  overflowY: 'auto',
}

export function ActionDialog({
  action,
  open,
  onClose,
}: {
  action: ActionWithProposal | null
  open: boolean
  onClose: () => void
}) {
  if (!action) return null

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      destroyOnClose
      title={
        <Space align="center" size={10}>
          <span>{actionLabel(action.tool_name)}</span>
          <Tag color="default">proposal #{action.proposal_id}</Tag>
          <Tag color="default">{PHASE_LABEL[action.phase] ?? action.phase}</Tag>
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          <Typography.Text strong>{action.proposal_domain}</Typography.Text> — {action.proposal_description}
        </Typography.Paragraph>

        {action.result_url && (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              RESULT
            </Typography.Text>
            <div style={{ marginTop: 4 }}>
              <a href={action.result_url} target="_blank" rel="noreferrer">
                <LinkOutlined /> {action.result_url}
              </a>
            </div>
          </div>
        )}

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            INPUT
          </Typography.Text>
          <pre className="mono" style={codeBlockStyle}>
            {prettyInput(action.tool_input)}
          </pre>
        </div>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            OUTPUT
          </Typography.Text>
          <pre className="mono" style={codeBlockStyle}>
            {prettyOutput(action.tool_output)}
          </pre>
        </div>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {new Date(action.occurred_at).toLocaleString()}
        </Typography.Text>
      </Space>
    </Modal>
  )
}
