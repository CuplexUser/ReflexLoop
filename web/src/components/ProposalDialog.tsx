import { useEffect, useState } from 'react'
import { App, Button, Collapse, Descriptions, Modal, Skeleton, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd'
import { ClockCircleOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { Link } from 'react-router-dom'
import type { ActionRow, OutcomeRow, ProposalRow, ReportRow, RunRow } from '../types'
import { api } from '../api'
import { READ_ONLY_HINT, useConsoleOnly } from '../consoleOnly'
import { UNFINISHED_ACT, canRerun, rerunConfirm, rerunLabel } from '../actStatus'
import { PHASE_LABEL, PRIORITY_LABEL, PRIORITY_TAG_COLOR, inWords, preview, recurrenceLabel, timeAgo } from '../format'
import { VERDICT_LABEL, VERDICT_TAG } from '../report'
import { palette } from '../theme'
import { MarkdownLite } from './MarkdownLite'
import { MonetizationBlock } from './MonetizationBlock'
import { MarketBlock } from './MarketBlock'
import { ReportView } from './ReportView'
import { DecisionControls } from './DecisionControls'

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
  const [reports, setReports] = useState<ReportRow[] | null>(null)
  const [cancellingSchedule, setCancellingSchedule] = useState(false)
  const [rerunning, setRerunning] = useState(false)

  useEffect(() => {
    if (!open || !proposal) return
    setActions(null)
    setRuns([])
    setReports(null)
    let cancelled = false
    api
      .proposalReports(proposal.id)
      .then((rows) => !cancelled && setReports(rows))
      .catch(() => !cancelled && setReports([]))
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

  // Only legacy build-mode proposals carry a fence. Shown as plain history: those tools no
  // longer exist, and nothing reads the column any more.
  const legacyTools = proposal.required_tools
    .split(',')
    .map((t) => t.trim().replace(/^mcp__(memory|integrations)__/, ''))
    .filter(Boolean)
  const latestReport = reports?.[0]
  const earlierReports = reports?.slice(1) ?? []

  function rerunDeepDive() {
    if (!proposal) return
    // A finished deep dive is re-run deliberately or not at all -- see rerunConfirm.
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
      await api.rerunDeepDive(proposal.id)
      // "Queued" rather than "started": the scheduler picks it up on its own tick, and telling
      // someone it is running when it hasn't begun sends them looking for output that isn't
      // there yet.
      message.success(`Deep dive queued — idea #${proposal.id} runs on the next scheduler tick`)
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Queueing the deep dive failed')
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
          <span>Idea #{proposal.id}</span>
          <Tag color={STATUS_COLOR[proposal.status]}>{proposal.status}</Tag>
          <Tag color="default">{proposal.domain}</Tag>
          {latestReport && (
            <Tag color={VERDICT_TAG[latestReport.verdict]}>
              {VERDICT_LABEL[latestReport.verdict]} {latestReport.viability_score}/5
            </Tag>
          )}
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
            <Typography.Text strong>
              {proposal.status === 'rejected' ? 'Rejection reason: ' : 'Operator notes / focus questions: '}
            </Typography.Text>
            {proposal.human_notes}
          </Typography.Paragraph>
        )}

        {/* The deep dive's verdict leads, once there is one -- it is what this idea came to. */}
        {proposal.status === 'approved' && (
          <div>
            <Space align="center" size={8} style={{ marginBottom: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                DEEP-DIVE REPORT
              </Typography.Text>
              {latestReport && (
                <Link to={`/reports/${latestReport.id}`} onClick={onClose} style={{ fontSize: 12 }}>
                  open report #{latestReport.id}
                </Link>
              )}
            </Space>
            {reports === null ? (
              <Skeleton active paragraph={{ rows: 3 }} />
            ) : latestReport ? (
              <>
                <ReportView report={latestReport} />
                {earlierReports.length > 0 && (
                  <Collapse
                    size="small"
                    style={{ marginTop: 12 }}
                    items={[
                      {
                        key: 'earlier',
                        label: `${earlierReports.length} earlier report${earlierReports.length === 1 ? '' : 's'}`,
                        children: (
                          <Space direction="vertical" size={4}>
                            {earlierReports.map((r) => (
                              <Space key={r.id} size={6} wrap>
                                <Link to={`/reports/${r.id}`} onClick={onClose}>
                                  #{r.id}
                                </Link>
                                <Tag color={VERDICT_TAG[r.verdict]}>
                                  {VERDICT_LABEL[r.verdict]} {r.viability_score}/5
                                </Tag>
                                <Typography.Text type="secondary">{timeAgo(r.created_at)}</Typography.Text>
                              </Space>
                            ))}
                          </Space>
                        ),
                      },
                    ]}
                  />
                )}
              </>
            ) : (
              <Typography.Text type="secondary">
                {proposal.market_json === null && legacyTools.length > 0
                  ? 'Approved in the retired build mode, so it has no deep-dive report. Run a deep dive to get one.'
                  : proposal.act_status === 'running'
                    ? 'The deep dive is running; its report lands here when it is submitted.'
                    : 'No report yet.'}
              </Typography.Text>
            )}
          </div>
        )}

        <MarketBlock proposal={proposal} />

        <MonetizationBlock proposal={proposal} />

        <Space size={40} wrap>
          <Statistic title="Est. cost to validate" value={proposal.expected_cost} precision={2} prefix="$" />
          <Statistic title="Est. hours to first signal" value={proposal.expected_time_hours} suffix="h" />
          <Statistic
            title="Est. first-year revenue"
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

        {legacyTools.length > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Legacy build-mode tool fence: <span className="mono">{legacyTools.join(', ')}</span>
          </Typography.Text>
        )}

        {proposal.status === 'approved' && (
          <Space align="center" size={10} wrap>
            <Tag color={PRIORITY_TAG_COLOR[proposal.priority]}>{PRIORITY_LABEL[proposal.priority]} priority</Tag>
            {/* Why there is no report, next to the button that does something about it. */}
            {UNFINISHED_ACT[proposal.act_status ?? ''] && (
              <Tooltip title={UNFINISHED_ACT[proposal.act_status ?? '']}>
                <Tag color={proposal.act_status === 'running' ? 'processing' : 'error'}>
                  deep dive {proposal.act_status}
                </Tag>
              </Tooltip>
            )}
            {canRerun(proposal) && (
              <Tooltip title={readOnly ? READ_ONLY_HINT : 'Queue a deep dive on this idea'}>
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<PlayCircleOutlined />}
                  loading={rerunning}
                  disabled={readOnly}
                  onClick={rerunDeepDive}
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
          <Descriptions size="small" column={4} bordered title="Legacy outcome (build mode)">
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
                { title: 'Phase', dataIndex: 'phase', width: 110, render: (v: string) => PHASE_LABEL[v] ?? v },
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
