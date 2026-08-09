import { useEffect, useState } from 'react'
import { Descriptions, Skeleton, Table, Tag, Typography } from 'antd'
import type { ActionRow, OutcomeRow, ProposalRow } from '../types'
import { api } from '../api'
import { preview } from '../format'

export function ProposalDetail({ proposal, outcome }: { proposal: ProposalRow; outcome?: OutcomeRow }) {
  const [actions, setActions] = useState<ActionRow[] | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .proposalActions(proposal.id)
      .then((rows) => !cancelled && setActions(rows))
      .catch(() => !cancelled && setActions([]))
    return () => {
      cancelled = true
    }
  }, [proposal.id])

  return (
    <div style={{ padding: '8px 24px 20px' }}>
      <Typography.Paragraph>{proposal.description}</Typography.Paragraph>

      {proposal.human_notes && (
        <Typography.Paragraph type="secondary">
          <Typography.Text strong>Human notes: </Typography.Text>
          {proposal.human_notes}
        </Typography.Paragraph>
      )}

      {outcome && (
        <Descriptions size="small" column={4} bordered style={{ marginBottom: 16 }}>
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
            {
              title: 'Input',
              dataIndex: 'tool_input',
              render: (v) => <span className="mono">{preview(v, 100)}</span>,
            },
            { title: 'When', dataIndex: 'occurred_at', width: 160, render: (v) => new Date(v).toLocaleString() },
          ]}
        />
      )}
    </div>
  )
}
