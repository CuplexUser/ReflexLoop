import { useState } from 'react'
import { Table, Tag } from 'antd'
import type { OutcomeRow, ProposalRow } from '../types'
import { ProposalDialog } from '../components/ProposalDialog'
import { timeAgo } from '../format'

const STATUS_COLOR: Record<ProposalRow['status'], string> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
}

export function ProposalsPage({ proposals, outcomes }: { proposals: ProposalRow[]; outcomes: OutcomeRow[] }) {
  const outcomeByProposal = new Map(outcomes.map((o) => [o.proposal_id, o]))
  const [selected, setSelected] = useState<ProposalRow | null>(null)

  return (
    <>
      <Table
        rowKey="id"
        dataSource={proposals}
        pagination={{ pageSize: 10 }}
        onRow={(p) => ({ onClick: () => setSelected(p), style: { cursor: 'pointer' } })}
        columns={[
          { title: '#', dataIndex: 'id', width: 60 },
          { title: 'Domain', dataIndex: 'domain', width: 200, ellipsis: true },
          { title: 'Description', dataIndex: 'description', ellipsis: true },
          {
            title: 'Status',
            dataIndex: 'status',
            width: 110,
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
            render: (_, p) => (
              <span className="mono" style={{ fontSize: 12 }}>
                ${p.expected_cost} · {p.expected_time_hours}h · ${p.expected_upside}
              </span>
            ),
          },
          { title: 'Created', dataIndex: 'created_at', width: 110, render: (v: string) => timeAgo(v) },
        ]}
      />
      <ProposalDialog
        proposal={selected}
        outcome={selected ? outcomeByProposal.get(selected.id) : undefined}
        open={selected !== null}
        onClose={() => setSelected(null)}
      />
    </>
  )
}
