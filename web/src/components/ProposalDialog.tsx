import { useEffect, useState } from 'react'
import { App, Button, Descriptions, Divider, Input, Modal, Skeleton, Space, Statistic, Table, Tag, Typography } from 'antd'
import { CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import type { ActionRow, OutcomeRow, ProposalRow } from '../types'
import { api, type ScheduleOptions } from '../api'
import { PRIORITY_LABEL, PRIORITY_TAG_COLOR, inWords, preview, recurrenceLabel } from '../format'
import { palette } from '../theme'
import { SchedulePriorityFields } from './SchedulePriorityFields'
import { MarkdownLite } from './MarkdownLite'

const STATUS_COLOR: Record<ProposalRow['status'], string> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
}

export function ProposalDialog({
  proposal,
  outcome,
  open,
  onClose,
}: {
  proposal: ProposalRow | null
  outcome?: OutcomeRow
  open: boolean
  onClose: () => void
}) {
  const { message } = App.useApp()
  const [actions, setActions] = useState<ActionRow[] | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null)
  const [showSchedule, setShowSchedule] = useState(false)
  const [schedule, setSchedule] = useState<ScheduleOptions>({})
  const [cancellingSchedule, setCancellingSchedule] = useState(false)

  useEffect(() => {
    if (!open || !proposal) return
    setActions(null)
    setRejecting(false)
    setNotes('')
    setSubmitting(null)
    setShowSchedule(false)
    setSchedule({})
    let cancelled = false
    api
      .proposalActions(proposal.id)
      .then((rows) => !cancelled && setActions(rows))
      .catch(() => !cancelled && setActions([]))
    return () => {
      cancelled = true
    }
  }, [open, proposal])

  if (!proposal) return null

  const tools = proposal.required_tools
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  async function decide(approved: boolean) {
    if (!proposal) return
    setSubmitting(approved ? 'approve' : 'reject')
    try {
      await api.decide(proposal.id, approved, notes || undefined, approved ? schedule : undefined)
      message.success(approved ? `Approved proposal #${proposal.id}` : `Rejected proposal #${proposal.id}`)
      onClose()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Decision failed')
    } finally {
      setSubmitting(null)
    }
  }

  async function cancelSchedule() {
    if (!proposal) return
    setCancellingSchedule(true)
    try {
      await api.cancelSchedule(proposal.id)
      message.success('Schedule cancelled')
      onClose()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Cancel schedule failed')
    } finally {
      setCancellingSchedule(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      destroyOnClose
      title={
        <Space align="center" size={10}>
          <span>Proposal #{proposal.id}</span>
          <Tag color={STATUS_COLOR[proposal.status]}>{proposal.status}</Tag>
          <Tag color="default">{proposal.domain}</Tag>
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <MarkdownLite text={proposal.description} />

        {proposal.human_notes && (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            <Typography.Text strong>Human notes: </Typography.Text>
            {proposal.human_notes}
          </Typography.Paragraph>
        )}

        <Space size={40} wrap>
          <Statistic title="Expected cost" value={proposal.expected_cost} precision={2} prefix="$" />
          <Statistic title="Expected time" value={proposal.expected_time_hours} suffix="h" />
          <Statistic
            title="Expected upside"
            value={proposal.expected_upside}
            precision={2}
            prefix="$"
            valueStyle={{ color: palette.approved }}
          />
        </Space>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            TOOLS REQUIRED
          </Typography.Text>
          <div style={{ marginTop: 4 }}>
            {tools.map((t) => (
              <Tag key={t} className="mono">
                {t}
              </Tag>
            ))}
          </div>
        </div>

        {proposal.status === 'approved' && (
          <Space align="center" size={10} wrap>
            <Tag color={PRIORITY_TAG_COLOR[proposal.priority]}>{PRIORITY_LABEL[proposal.priority]} priority</Tag>
            {proposal.next_run_at && (
              <Tag icon={<ClockCircleOutlined />} color="processing">
                next run {inWords(proposal.next_run_at)}
                {proposal.recurrence_ms ? ` · ${recurrenceLabel(proposal.recurrence_ms)}` : ''}
              </Tag>
            )}
            {(proposal.next_run_at || proposal.recurrence_ms) && (
              <Button size="small" danger ghost loading={cancellingSchedule} onClick={cancelSchedule}>
                Cancel schedule
              </Button>
            )}
          </Space>
        )}

        {outcome && (
          <Descriptions size="small" column={4} bordered>
            <Descriptions.Item label="Actual revenue">${outcome.actual_revenue.toFixed(2)}</Descriptions.Item>
            <Descriptions.Item label="Actual cost">${outcome.actual_cost.toFixed(2)}</Descriptions.Item>
            <Descriptions.Item label="Actual time">{outcome.actual_time_hours ?? '—'}h</Descriptions.Item>
            <Descriptions.Item label="Success">
              <Tag color={outcome.success ? 'success' : 'error'}>{outcome.success ? 'yes' : 'no'}</Tag>
            </Descriptions.Item>
            {outcome.notes && (
              <Descriptions.Item label="Outcome notes" span={4}>
                {outcome.notes}
              </Descriptions.Item>
            )}
          </Descriptions>
        )}

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            TOOL CALLS
          </Typography.Text>
          {actions === null ? (
            <Skeleton active paragraph={{ rows: 2 }} style={{ marginTop: 8 }} />
          ) : (
            <Table
              size="small"
              style={{ marginTop: 8 }}
              pagination={false}
              rowKey="id"
              dataSource={actions}
              locale={{ emptyText: 'No tool calls logged' }}
              columns={[
                { title: 'Phase', dataIndex: 'phase', width: 110 },
                { title: 'Tool', dataIndex: 'tool_name', width: 200, render: (v) => <span className="mono">{v}</span> },
                { title: 'Input', dataIndex: 'tool_input', render: (v) => <span className="mono">{preview(v, 100)}</span> },
                { title: 'When', dataIndex: 'occurred_at', width: 160, render: (v) => new Date(v).toLocaleString() },
              ]}
            />
          )}
        </div>

        {proposal.status === 'pending' && (
          <>
            <Divider style={{ margin: '4px 0' }} />
            {rejecting && (
              <Input.TextArea
                placeholder="Reason (optional) — saved with the rejection for future reference"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                autoSize={{ minRows: 2, maxRows: 4 }}
              />
            )}
            {!rejecting && (
              <div>
                <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setShowSchedule((v) => !v)}>
                  {showSchedule ? 'Hide schedule & priority' : 'Schedule & priority…'}
                </Button>
                {showSchedule && (
                  <div style={{ marginTop: 8 }}>
                    <SchedulePriorityFields onChange={setSchedule} />
                  </div>
                )}
              </div>
            )}
            <Space>
              <Button
                type="primary"
                icon={<CheckCircleOutlined />}
                loading={submitting === 'approve'}
                disabled={submitting !== null}
                style={{ background: palette.approved, borderColor: palette.approved }}
                onClick={() => decide(true)}
              >
                Approve
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
                <Button
                  danger
                  ghost
                  icon={<CloseCircleOutlined />}
                  disabled={submitting !== null}
                  onClick={() => setRejecting(true)}
                >
                  Reject
                </Button>
              )}
            </Space>
          </>
        )}
      </Space>
    </Modal>
  )
}
