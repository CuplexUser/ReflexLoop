import { useState } from 'react'
import { App, Button, Divider, Input, Space, Typography } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, EditOutlined } from '@ant-design/icons'
import type { ProposalRow } from '../types'
import { api, type ScheduleOptions, type ScopeEdits } from '../api'
import { palette } from '../theme'
import { SchedulePriorityFields } from './SchedulePriorityFields'
import { ToolFence } from './ToolFence'

/**
 * The approve/reject flow, shared by the dashboard review card and the proposal dialog so the
 * two can't drift on what an operator is allowed to change at decision time.
 *
 * Scope edits (description + required_tools) are sent with the decision and applied server-side
 * *before* the status flips, so what gets approved is exactly what the act phase is fenced to.
 */
export function DecisionControls({ proposal, onDecided }: { proposal: ProposalRow; onDecided?: () => void }) {
  const { message } = App.useApp()
  const [rejecting, setRejecting] = useState(false)
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null)
  const [showSchedule, setShowSchedule] = useState(false)
  const [schedule, setSchedule] = useState<ScheduleOptions>({})

  const originalTools = proposal.required_tools
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const [editing, setEditing] = useState(false)
  const [tools, setTools] = useState<string[]>(originalTools)
  const [description, setDescription] = useState(proposal.description)

  const toolsChanged = tools.join(',') !== originalTools.join(',')
  const descriptionChanged = description !== proposal.description
  const edited = toolsChanged || descriptionChanged

  async function decide(approved: boolean) {
    setSubmitting(approved ? 'approve' : 'reject')
    try {
      const edits: ScopeEdits | undefined =
        approved && edited
          ? {
              ...(descriptionChanged ? { editedDescription: description } : {}),
              ...(toolsChanged ? { editedRequiredTools: tools } : {}),
            }
          : undefined
      await api.decide(proposal.id, approved, notes || undefined, approved ? schedule : undefined, edits)
      message.success(
        approved
          ? `Approved proposal #${proposal.id}${edited ? ' with edits' : ''}`
          : `Rejected proposal #${proposal.id}`,
      )
      onDecided?.()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Decision failed')
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {editing ? (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            SCOPE (edit before approving)
          </Typography.Text>
          <Input.TextArea
            style={{ marginTop: 4 }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            autoSize={{ minRows: 4, maxRows: 12 }}
          />
        </div>
      ) : null}

      <ToolFence tools={tools} editable={editing} onChange={setTools} />

      {!rejecting && (
        <Space size={16} wrap>
          <Button type="link" size="small" style={{ padding: 0 }} icon={<EditOutlined />} onClick={() => setEditing((v) => !v)}>
            {editing ? 'Done editing' : 'Edit scope…'}
          </Button>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setShowSchedule((v) => !v)}>
            {showSchedule ? 'Hide schedule & priority' : 'Schedule & priority…'}
          </Button>
          {edited && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              Scope edited — approving saves your version, keeping the original on record.
            </Typography.Text>
          )}
        </Space>
      )}

      {showSchedule && !rejecting && <SchedulePriorityFields onChange={setSchedule} />}

      {rejecting && (
        <Input.TextArea
          placeholder="Reason (optional) — saved with the rejection, and used to teach the agent not to re-propose it"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          autoSize={{ minRows: 2, maxRows: 4 }}
        />
      )}

      <Divider style={{ margin: '4px 0' }} />

      <Space>
        <Button
          type="primary"
          icon={<CheckCircleOutlined />}
          loading={submitting === 'approve'}
          disabled={submitting !== null}
          style={{ background: palette.approved, borderColor: palette.approved }}
          onClick={() => decide(true)}
        >
          {edited ? 'Approve with edits' : 'Approve'}
        </Button>
        {rejecting ? (
          <Button
            danger
            icon={<CloseCircleOutlined />}
            loading={submitting === 'reject'}
            disabled={submitting !== null}
            onClick={() => decide(false)}
          >
            Confirm reject
          </Button>
        ) : (
          <Button danger ghost icon={<CloseCircleOutlined />} disabled={submitting !== null} onClick={() => setRejecting(true)}>
            Reject
          </Button>
        )}
      </Space>
    </Space>
  )
}
