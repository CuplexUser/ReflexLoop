import { useMemo, useState } from 'react'
import { Input, Space, Table, Tag, Typography } from 'antd'
import type { OutcomeRow, Priority, ProposalRow } from '../types'
import { ProposalDialog } from '../components/ProposalDialog'
import { PRIORITY_LABEL, PRIORITY_TAG_COLOR, inWords, markdownPreview, recurrenceLabel, timeAgo } from '../format'
import { useResizableColumns } from '../hooks/useResizableColumns'

const STATUS_COLOR: Record<ProposalRow['status'], string> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
}

const PRIORITY_RANK: Record<Priority, number> = { urgent: 3, high: 2, normal: 1, low: 0 }

export function ProposalsPage({ proposals, outcomes }: { proposals: ProposalRow[]; outcomes: OutcomeRow[] }) {
  const outcomeByProposal = new Map(outcomes.map((o) => [o.proposal_id, o]))
  const [selected, setSelected] = useState<ProposalRow | null>(null)
  const [search, setSearch] = useState('')

  const domainFilters = useMemo(
    () => [...new Set(proposals.map((p) => p.domain))].sort().map((d) => ({ text: d, value: d })),
    [proposals],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return proposals
    return proposals.filter((p) => `${p.domain} ${p.description}`.toLowerCase().includes(q))
  }, [proposals, search])

  const { columns, components, scroll } = useResizableColumns<ProposalRow>('proposals', [
    { title: '#', dataIndex: 'id', width: 70, sorter: (a, b) => a.id - b.id },
    {
      title: 'Domain',
      dataIndex: 'domain',
      width: 200,
      ellipsis: true,
      sorter: (a, b) => a.domain.localeCompare(b.domain),
      filters: domainFilters,
      onFilter: (value, record) => record.domain === value,
    },
    {
      title: 'Description',
      dataIndex: 'description',
      ellipsis: true,
      sorter: (a, b) => a.description.localeCompare(b.description),
      render: (v: string) => markdownPreview(v),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 110,
      sorter: (a, b) => a.status.localeCompare(b.status),
      filters: [
        { text: 'pending', value: 'pending' },
        { text: 'approved', value: 'approved' },
        { text: 'rejected', value: 'rejected' },
      ],
      onFilter: (value, record) => record.status === value,
      render: (status: ProposalRow['status']) => <Tag color={STATUS_COLOR[status]}>{status}</Tag>,
    },
    {
      title: 'Priority',
      dataIndex: 'priority',
      width: 110,
      sorter: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
      filters: (['urgent', 'high', 'normal', 'low'] as Priority[]).map((p) => ({ text: PRIORITY_LABEL[p], value: p })),
      onFilter: (value, record) => record.priority === value,
      render: (p: Priority) => <Tag color={PRIORITY_TAG_COLOR[p]}>{PRIORITY_LABEL[p]}</Tag>,
    },
    {
      title: 'Schedule',
      width: 170,
      sorter: (a, b) => (a.next_run_at ?? '').localeCompare(b.next_run_at ?? ''),
      render: (_, p) =>
        p.next_run_at ? (
          <span style={{ fontSize: 12 }}>
            {inWords(p.next_run_at)}
            {p.recurrence_ms ? ` · ${recurrenceLabel(p.recurrence_ms)}` : ''}
          </span>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Typography.Text>
        ),
    },
    {
      title: 'Expected',
      width: 200,
      sorter: (a, b) => a.expected_upside - b.expected_upside,
      render: (_, p) => (
        <span className="mono" style={{ fontSize: 12 }}>
          ${p.expected_cost} · {p.expected_time_hours}h · ${p.expected_upside}
        </span>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      width: 110,
      sorter: (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      defaultSortOrder: 'descend',
      render: (v: string) => timeAgo(v),
    },
  ])

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Input.Search
        allowClear
        placeholder="Search domain or description…"
        style={{ maxWidth: 360 }}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <Table
        rowKey="id"
        dataSource={filtered}
        pagination={{ pageSize: 10 }}
        components={components}
        scroll={scroll}
        onRow={(p) => ({ onClick: () => setSelected(p), style: { cursor: 'pointer' } })}
        columns={columns}
      />
      <ProposalDialog
        proposal={selected}
        outcome={selected ? outcomeByProposal.get(selected.id) : undefined}
        open={selected !== null}
        onClose={() => setSelected(null)}
      />
    </Space>
  )
}
