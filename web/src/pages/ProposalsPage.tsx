import { useMemo, useState } from 'react'
import { Input, Space, Table, Tag } from 'antd'
import type { OutcomeRow, ProposalRow } from '../types'
import { ProposalDialog } from '../components/ProposalDialog'
import { timeAgo } from '../format'
import { useResizableColumns } from '../hooks/useResizableColumns'

const STATUS_COLOR: Record<ProposalRow['status'], string> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
}

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

  const { columns, components } = useResizableColumns<ProposalRow>([
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
      <div style={{ overflowX: 'auto' }}>
        <Table
          rowKey="id"
          dataSource={filtered}
          pagination={{ pageSize: 10 }}
          components={components}
          onRow={(p) => ({ onClick: () => setSelected(p), style: { cursor: 'pointer' } })}
          columns={columns}
        />
      </div>
      <ProposalDialog
        proposal={selected}
        outcome={selected ? outcomeByProposal.get(selected.id) : undefined}
        open={selected !== null}
        onClose={() => setSelected(null)}
      />
    </Space>
  )
}
