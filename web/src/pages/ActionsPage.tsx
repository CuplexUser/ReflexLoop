import { useEffect, useState } from 'react'
import { LinkOutlined } from '@ant-design/icons'
import { Segmented, Space, Table, Tag, Typography } from 'antd'
import type { ActionWithProposal } from '../types'
import { api } from '../api'
import { PHASE_LABEL, actionDescription, actionLabel, timeAgo } from '../format'
import { ActionDialog } from '../components/ActionDialog'

type PhaseFilter = 'all' | 'act' | 'reflect'

export function ActionsPage({ historyVersion }: { historyVersion: number }) {
  const [actions, setActions] = useState<ActionWithProposal[]>([])
  const [loading, setLoading] = useState(true)
  const [phase, setPhase] = useState<PhaseFilter>('all')
  const [selected, setSelected] = useState<ActionWithProposal | null>(null)

  useEffect(() => {
    api
      .actions()
      .then(setActions)
      .finally(() => setLoading(false))
  }, [historyVersion])

  const filtered = phase === 'all' ? actions : actions.filter((a) => a.phase === phase)

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Segmented
        value={phase}
        onChange={(v) => setPhase(v as PhaseFilter)}
        options={[
          { label: 'All phases', value: 'all' },
          { label: PHASE_LABEL.act, value: 'act' },
          { label: PHASE_LABEL.reflect, value: 'reflect' },
        ]}
      />
      <Table
        rowKey="id"
        loading={loading}
        dataSource={filtered}
        pagination={{ pageSize: 20 }}
        onRow={(a) => ({ onClick: () => setSelected(a), style: { cursor: 'pointer' } })}
        locale={{ emptyText: 'No actions taken on approved proposals yet' }}
        columns={[
          {
            title: 'Proposal',
            width: 260,
            ellipsis: true,
            render: (_, a) => (
              <span>
                <Tag color="default">#{a.proposal_id}</Tag> {a.proposal_domain}
              </span>
            ),
          },
          { title: 'Action', dataIndex: 'tool_name', width: 140, render: (v: string) => actionLabel(v) },
          {
            title: 'Description',
            ellipsis: true,
            render: (_, a) => actionDescription(a.tool_name, a.tool_input),
          },
          {
            title: 'Result',
            width: 130,
            render: (_, a) =>
              a.result_url ? (
                <a href={a.result_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                  <LinkOutlined /> open
                </a>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          { title: 'When', dataIndex: 'occurred_at', width: 110, render: (v: string) => timeAgo(v) },
        ]}
      />
      <ActionDialog action={selected} open={selected !== null} onClose={() => setSelected(null)} />
    </Space>
  )
}
