import { useEffect, useState } from 'react'
import { App, Button, Descriptions, Modal, Skeleton, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd'
import { ClockCircleOutlined, EditOutlined, PlayCircleOutlined } from '@ant-design/icons'
import type { ActionRow, OutcomeRow, ProposalRow, RunRow } from '../types'
import { api } from '../api'
import { READ_ONLY_HINT, useConsoleOnly } from '../consoleOnly'
import { UNFINISHED_ACT, canRerun, rerunConfirm, rerunLabel } from '../actStatus'
import { PRIORITY_LABEL, PRIORITY_TAG_COLOR, inWords, preview, recurrenceLabel, timeAgo } from '../format'
import { palette } from '../theme'
import { MarkdownLite } from './MarkdownLite'
import { MonetizationBlock } from './MonetizationBlock'
import { DecisionControls } from './DecisionControls'
import { ToolFence } from './ToolFence'

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
  const { message, modal } = App.useApp()
  const readOnly = useConsoleOnly()
  const [actions, setActions] = useState<ActionRow[] | null>(null)
  const [runs, setRuns] = useState<RunRow[]>([])
  const [cancellingSchedule, setCancellingSchedule] = useState(false)
  const [rerunning, setRerunning] = useState(false)
  const [editingScope, setEditingScope] = useState(false)
  const [scopeTools, setScopeTools] = useState<string[]>([])
  const [savingScope, setSavingScope] = useState(false)

  useEffect(() => {
    if (!open || !proposal) return
    setActions(null)
    setRuns([])
    setEditingScope(false)
    let cancelled = false
    api
      .proposalActions(proposal.id)
      .then((rows) => !cancelled && setActions(rows))
      .catch(() => !cancelled && setActions([]))
    api
      .proposalRuns(proposal.id)
      .then((rows) => !cancelled && setRuns(rows))
      .catch(() => !cancelled && setRuns([]))
    return () => {
      cancelled = true
    }
  }, [open, proposal])

  if (!proposal) return null

  const tools = proposal.required_tools
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const originalTools = proposal.original_required_tools
    ?.split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  // The server enforces the same rule and 409s if we get it wrong; this just keeps the
  // button from appearing when it would obviously fail. `actions === null` means the fetch
  // hasn't landed yet, so hold off rather than offering an edit we may have to reject.
  const hasActed = (actions ?? []).some((a) => a.phase === 'act')
  // Read-only console: this endpoint is refused there, and narrowing a fence that no act phase
  // will read is meaningless anyway, so don't offer the edit at all.
  const scopeEditable = proposal.status === 'approved' && actions !== null && !hasActed && !readOnly

  async function saveScope() {
    if (!proposal) return
    setSavingScope(true)
    try {
      await api.editScope(proposal.id, { requiredTools: scopeTools })
      message.success(`Fence updated on proposal #${proposal.id}`)
      setEditingScope(false)
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Editing the fence failed')
    } finally {
      setSavingScope(false)
    }
  }

  function rerunBuild() {
    if (!proposal) return
    // A finished build is re-run deliberately or not at all -- see rerunConfirm. The dialog is
    // the same one the Deliverables card raises, from the same helper, because the two buttons
    // dispatch the same act phase.
    const confirm = rerunConfirm(proposal.act_status)
    if (confirm) {
      modal.confirm({ ...confirm, onOk: () => dispatchRerun() })
      return
    }
    void dispatchRerun()
  }

  async function dispatchRerun() {
    if (!proposal) return
    setRerunning(true)
    try {
      await api.rerunBuild(proposal.id)
      // "Queued" rather than "started": the scheduler picks it up on its own tick, and telling
      // someone a build is running when it hasn't begun sends them looking for output that
      // isn't there yet.
      message.success(`Build queued — proposal #${proposal.id} runs on the next scheduler tick`)
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Queueing the build failed')
    } finally {
      setRerunning(false)
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
        <Space align="center" size={10} wrap>
          <span>Proposal #{proposal.id}</span>
          <Tag color={STATUS_COLOR[proposal.status]}>{proposal.status}</Tag>
          <Tag color="default">{proposal.domain}</Tag>
          {proposal.status === 'pending' && (
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              pending {timeAgo(proposal.created_at)}
            </Typography.Text>
          )}
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <MarkdownLite text={proposal.description} />

        {proposal.original_description && (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
            <Typography.Text strong>Edited by a human before approval.</Typography.Text> The model originally
            wrote: {preview(proposal.original_description, 240)}
          </Typography.Paragraph>
        )}

        {proposal.human_notes && (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            <Typography.Text strong>Human notes: </Typography.Text>
            {proposal.human_notes}
          </Typography.Paragraph>
        )}

        <MonetizationBlock proposal={proposal} />

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
          {runs.length > 0 && (
            <Statistic
              title={`Model API spend (${runs.length} ${runs.length === 1 ? 'phase' : 'phases'})`}
              value={runs.reduce((sum, r) => sum + r.cost_usd, 0)}
              precision={4}
              prefix="$"
              valueStyle={{ color: palette.active }}
            />
          )}
        </Space>

        {/*
          Pending proposals get the editable fence inside DecisionControls. An approved one
          stays editable here until its act phase starts — a queued or scheduled proposal you
          can see is slightly wrong should be narrowable without cancelling it outright.
          Once it has acted the fence is history, so it's read-only.
        */}
        {proposal.status !== 'pending' && (
          <div>
            <Space align="center" size={8} style={{ marginBottom: editingScope ? 4 : 0 }}>
              {scopeEditable && !editingScope && (
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setScopeTools(tools)
                    setEditingScope(true)
                  }}
                >
                  Edit fence
                </Button>
              )}
              {editingScope && (
                <>
                  <Button size="small" type="primary" loading={savingScope} onClick={saveScope}>
                    Save fence
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      setEditingScope(false)
                      setScopeTools(tools)
                    }}
                  >
                    Cancel
                  </Button>
                </>
              )}
            </Space>
            <ToolFence
              tools={editingScope ? scopeTools : tools}
              editable={editingScope}
              onChange={setScopeTools}
            />
            {originalTools && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Fence edited — the model asked for: {originalTools.join(', ')}
              </Typography.Text>
            )}
          </div>
        )}

        {proposal.status === 'approved' && (
          <Space align="center" size={10} wrap>
            <Tag color={PRIORITY_TAG_COLOR[proposal.priority]}>{PRIORITY_LABEL[proposal.priority]} priority</Tag>
            {/* Why the build isn't done, next to the button that does something about it. An
                unfinished act phase is descheduled at startup rather than re-run, so without a
                control here the only way to resume one was a curl. */}
            {UNFINISHED_ACT[proposal.act_status ?? ''] && (
              <Tooltip title={UNFINISHED_ACT[proposal.act_status ?? '']}>
                <Tag color={proposal.act_status === 'running' ? 'processing' : 'error'}>
                  build {proposal.act_status}
                </Tag>
              </Tooltip>
            )}
            {canRerun(proposal) && (
              <Tooltip title={readOnly ? READ_ONLY_HINT : 'Queue this proposal’s act phase to run again'}>
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<PlayCircleOutlined />}
                  loading={rerunning}
                  disabled={readOnly}
                  onClick={rerunBuild}
                >
                  {rerunLabel(proposal.act_status)}
                </Button>
              </Tooltip>
            )}
            {proposal.next_run_at && (
              <Tag icon={<ClockCircleOutlined />} color="processing">
                next run {inWords(proposal.next_run_at)}
                {proposal.recurrence_ms ? ` · ${recurrenceLabel(proposal.recurrence_ms)}` : ''}
              </Tag>
            )}
            {(proposal.next_run_at || proposal.recurrence_ms) && (
              <Tooltip title={readOnly ? READ_ONLY_HINT : undefined}>
                <Button
                  size="small"
                  danger
                  ghost
                  loading={cancellingSchedule}
                  disabled={readOnly}
                  onClick={cancelSchedule}
                >
                  Cancel schedule
                </Button>
              </Tooltip>
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
              scroll={{ x: 620 }}
              locale={{ emptyText: 'No tool calls logged' }}
              columns={[
                { title: 'Phase', dataIndex: 'phase', width: 110 },
                { title: 'Tool', dataIndex: 'tool_name', width: 200, render: (v) => <span className="mono">{v}</span> },
                { title: 'Input', dataIndex: 'tool_input', render: (v) => <span className="mono">{preview(v, 100)}</span> },
                {
                  title: 'When',
                  dataIndex: 'occurred_at',
                  width: 160,
                  render: (v: string) => (
                    <Tooltip title={new Date(v).toLocaleString()}>
                      <span>{timeAgo(v)}</span>
                    </Tooltip>
                  ),
                },
              ]}
            />
          )}
        </div>

        {proposal.status === 'pending' && <DecisionControls proposal={proposal} onDecided={onClose} />}
      </Space>
    </Modal>
  )
}
