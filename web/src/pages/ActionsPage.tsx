import { useEffect, useMemo, useState } from 'react'
import { LinkOutlined } from '@ant-design/icons'
import { Input, Segmented, Space, Table, Tag, Typography } from 'antd'
import type { ActionWithProposal } from '../types'
import { api } from '../api'
import { PHASE_LABEL, actionDescription, actionLabel, timeAgo } from '../format'
import { ActionDialog } from '../components/ActionDialog'
import { useResizableColumns } from '../hooks/useResizableColumns'

type PhaseFilter = 'all' | 'act' | 'reflect'

export function ActionsPage({ historyVersion }: { historyVersion: number }) {
  const [actions, setActions] = useState<ActionWithProposal[]>([])
  const [loading, setLoading] = useState(true)
  const [phase, setPhase] = useState<PhaseFilter>('all')
  const [selected, setSelected] = useState<ActionWithProposal | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    api
      .actions()
      .then(setActions)
      .finally(() => setLoading(false))
  }, [historyVersion])

  const byPhase = phase === 'all' ? actions : actions.filter((a) => a.phase === phase)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return byPhase
    return byPhase.filter((a) =>
      `${a.proposal_domain} ${actionLabel(a.tool_name)} ${actionDescription(a.tool_name, a.tool_input)}`
        .toLowerCase()
        .includes(q),
    )
  }, [byPhase, search])

  const domainFilters = useMemo(
    () => [...new Set(actions.map((a) => a.proposal_domain))].sort().map((d) => ({ text: d, value: d })),
    [actions],
  )
  const actionFilters = useMemo(
    () => [...new Set(actions.map((a) => a.tool_name))].sort().map((t) => ({ text: actionLabel(t), value: t })),
    [actions],
  )

  const { columns, components } = useResizableColumns<ActionWithProposal>([
    {
      title: 'Proposal',
      width: 260,
      ellipsis: true,
      sorter: (a, b) => a.proposal_id - b.proposal_id,
      filters: domainFilters,
      onFilter: (value, record) => record.proposal_domain === value,
      render: (_, a) => (
        <span>
          <Tag color="default">#{a.proposal_id}</Tag> {a.proposal_domain}
        </span>
      ),
    },
    {
      title: 'Action',
      dataIndex: 'tool_name',
      width: 140,
      sorter: (a, b) => a.tool_name.localeCompare(b.tool_name),
      filters: actionFilters,
      onFilter: (value, record) => record.tool_name === value,
      render: (v: string) => actionLabel(v),
    },
    {
      title: 'Description',
      ellipsis: true,
      render: (_, a) => actionDescription(a.tool_name, a.tool_input),
    },
    {
      title: 'Result',
      width: 130,
      sorter: (a, b) => Number(Boolean(a.result_url)) - Number(Boolean(b.result_url)),
      render: (_, a) =>
        a.result_url ? (
          <a href={a.result_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            <LinkOutlined /> open
          </a>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: 'When',
      dataIndex: 'occurred_at',
      width: 110,
      sorter: (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
      defaultSortOrder: 'descend',
      render: (v: string) => timeAgo(v),
    },
  ])

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space size={16} wrap>
        <Segmented
          value={phase}
          onChange={(v) => setPhase(v as PhaseFilter)}
          options={[
            { label: 'All phases', value: 'all' },
            { label: PHASE_LABEL.act, value: 'act' },
            { label: PHASE_LABEL.reflect, value: 'reflect' },
          ]}
        />
        <Input.Search
          allowClear
          placeholder="Search proposal, action, or description…"
          style={{ maxWidth: 360 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </Space>
      <div style={{ overflowX: 'auto' }}>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={filtered}
          pagination={{ pageSize: 20 }}
          components={components}
          onRow={(a) => ({ onClick: () => setSelected(a), style: { cursor: 'pointer' } })}
          locale={{ emptyText: 'No actions taken on approved proposals yet' }}
          columns={columns}
        />
      </div>
      <ActionDialog action={selected} open={selected !== null} onClose={() => setSelected(null)} />
    </Space>
  )
}
