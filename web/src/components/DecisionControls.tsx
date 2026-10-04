import { Suspense, lazy, useState } from 'react'
import { App, Button, Divider, Input, Space, Spin, Tooltip, Typography } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, EditOutlined } from '@ant-design/icons'
import type { ProposalRow } from '../types'
import { api, type ScheduleOptions, type ScopeEdits } from '../api'
import { READ_ONLY_HINT, useConsoleOnly } from '../consoleOnly'
import { palette } from '../theme'

/**
 * DatePicker + dayjs are by far the heaviest thing on the approve surface, and they only render
 * once the operator opens "Schedule & priority…". Loading them on demand keeps them off the
 * dashboard's first paint, which renders this card the moment an idea is pending.
 */
const SchedulePriorityFields = lazy(() =>
  import('./SchedulePriorityFields').then((m) => ({ default: m.SchedulePriorityFields })),
)

/**
 * The approve/reject flow, shared by the dashboard review card and the idea dialog so the two
 * can't drift on what an operator is allowed to change at decision time.
 *
 * Approving starts a deep dive. The notes field means something on both sides: on a rejection
 * it is the reason (which the agent learns from), on an approval it is the questions the deep
 * dive's report has to answer first. A description edit is applied server-side before the
 * status flips, so the deep dive investigates the idea as approved.
 */
export function DecisionControls({ proposal, onDecided }: { proposal: ProposalRow; onDecided?: () => void }) {
  const { message } = App.useApp()
  const consoleOnly = useConsoleOnly()
  const [rejecting, setRejecting] = useState(false)
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null)
  const [showSchedule, setShowSchedule] = useState(false)
  const [schedule, setSchedule] = useState<ScheduleOptions>({})

  const [editing, setEditing] = useState(false)
  const [description, setDescription] = useState(proposal.description)
  const edited = description !== proposal.description

  async function decide(approved: boolean) {
    setSubmitting(approved ? 'approve' : 'reject')
    try {
      const edits: ScopeEdits | undefined = approved && edited ? { editedDescription: description } : undefined
      await api.decide(proposal.id, approved, notes.trim() || undefined, approved ? schedule : undefined, edits)
      message.success(
        approved
          ? `Approved idea #${proposal.id}${edited ? ' with edits' : ''} -- deep dive queued`
          : `Rejected idea #${proposal.id}`,
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
            DESCRIPTION (edit before approving)
          </Typography.Text>
          <Input.TextArea
            style={{ marginTop: 4 }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            autoSize={{ minRows: 4, maxRows: 12 }}
          />
        </div>
      ) : null}

      {!rejecting && (
        <Space size={16} wrap>
          <Button type="link" size="small" style={{ padding: 0 }} icon={<EditOutlined />} onClick={() => setEditing((v) => !v)}>
            {editing ? 'Done editing' : 'Edit description…'}
          </Button>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setShowSchedule((v) => !v)}>
            {showSchedule ? 'Hide schedule & priority' : 'Schedule & priority…'}
          </Button>
          {edited && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              Description edited — approving saves your version, keeping the original on record.
            </Typography.Text>
          )}
        </Space>
      )}

      {showSchedule && !rejecting && (
        <Suspense fallback={<Spin size="small" />}>
          <SchedulePriorityFields onChange={setSchedule} />
        </Suspense>
      )}

      <Input.TextArea
        placeholder={
          rejecting
            ? 'Reason (optional) — saved with the rejection, and used to teach the agent not to re-propose it'
            : 'Focus questions for the deep dive (optional) — e.g. "Is there demand outside Sweden? What do agencies pay?"'
        }
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        autoSize={{ minRows: 2, maxRows: 4 }}
      />

      <Divider style={{ margin: '4px 0' }} />

      {/* A decision resolves a promise inside the agent process. There is no such promise in
          console-only mode, so the endpoint refuses it -- say that before the click. */}
      <Tooltip title={consoleOnly ? READ_ONLY_HINT : undefined}>
        <Space>
          <Button
            type="primary"
            icon={<CheckCircleOutlined />}
            loading={submitting === 'approve'}
            disabled={submitting !== null || consoleOnly}
            style={consoleOnly ? undefined : { background: palette.approved, borderColor: palette.approved }}
            onClick={() => decide(true)}
          >
            {edited ? 'Approve with edits' : 'Approve deep dive'}
          </Button>
          {rejecting ? (
            <Button
              danger
              icon={<CloseCircleOutlined />}
              loading={submitting === 'reject'}
              disabled={submitting !== null || consoleOnly}
              onClick={() => decide(false)}
            >
              Confirm reject
            </Button>
          ) : (
            <Button
              danger
              ghost
              icon={<CloseCircleOutlined />}
              disabled={submitting !== null || consoleOnly}
              onClick={() => setRejecting(true)}
            >
              Reject
            </Button>
          )}
        </Space>
      </Tooltip>
    </Space>
  )
}
