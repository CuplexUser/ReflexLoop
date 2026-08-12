import { useEffect, useMemo, useState } from 'react'
import { LinkOutlined } from '@ant-design/icons'
import { Input, Segmented, Select, Space, Table, Tag, Typography } from 'antd'
import type { ActionWithProposal, OutcomeRow, Priority, ProposalRow } from '../types'
import { api } from '../api'
import {
  PHASE_LABEL,
  PRIORITY_LABEL,
  PRIORITY_TAG_COLOR,
  actionDescription,
  actionLabel,
  inWords,
  recurrenceLabel,
  timeAgo,
} from '../format'
import { ActionDialog } from '../components/ActionDialog'
import { useResizableColumns } from '../hooks/useResizableColumns'

type PhaseFilter = 'all' | 'act' | 'reflect'
type ReviewStatus = ProposalRow['review_status']

const PRIORITY_RANK: Record<Priority, number> = { urgent: 3, high: 2, normal: 1, low: 0 }

interface ProposalGroup {
  proposal: ProposalRow
  outcome?: OutcomeRow
  actions: ActionWithProposal[]
  lastActivity: string
}

const REVIEW_OPTIONS: { value: NonNullable<ReviewStatus> | 'unreviewed'; label: string }[] = [
  { value: 'unreviewed', label: 'Unreviewed' },
  { value: 'mvp_done', label: '✓ MVP done' },
  { value: 'needs_refinement', label: '⚠ Needs refinement' },
]

function reviewRank(status: ReviewStatus): number {
  if (status === 'mvp_done') return 2
  if (status === 'needs_refinement') return 1
  return 0
}

/** The action list for one proposal, shown inline when its group row is expanded. */
function ExpandedActions({
  actions,
  onSelect,
}: {
  actions: ActionWithProposal[]
  onSelect: (a: ActionWithProposal) => void
}) {
  const sorted = useMemo(() => [...actions].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)), [actions])

  const { columns, components } = useResizableColumns<ActionWithProposal>([
    { title: 'Action', dataIndex: 'tool_name', width: 140, render: (v: string) => actionLabel(v) },
    { title: 'Description', ellipsis: true, render: (_, a) => actionDescription(a.tool_name, a.tool_input) },
    {
      title: 'Result',
      width: 110,
      render: (_, a) =>
        a.result_url ? (
          <a href={a.result_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            <LinkOutlined /> open
          </a>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    { title: 'When', width: 110, render: (_, a) => timeAgo(a.occurred_at) },
  ])

  return (
    <div style={{ overflowX: 'auto' }}>
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={sorted}
        components={components}
        columns={columns}
        onRow={(a) => ({ onClick: () => onSelect(a), style: { cursor: 'pointer' } })}
      />
    </div>
  )
}

export function ActionsPage({
  historyVersion,
  proposals,
  outcomes,
  onSetReview,
}: {
  historyVersion: number
  proposals: ProposalRow[]
  outcomes: OutcomeRow[]
  onSetReview: (id: number, reviewStatus: ReviewStatus) => void
}) {
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

  const filteredActions = useMemo(() => {
    let rows = phase === 'all' ? actions : actions.filter((a) => a.phase === phase)
    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter((a) =>
        `${a.proposal_domain} ${a.proposal_description} ${actionLabel(a.tool_name)} ${actionDescription(a.tool_name, a.tool_input)}`
          .toLowerCase()
          .includes(q),
      )
    }
    return rows
  }, [actions, phase, search])

  const groups = useMemo<ProposalGroup[]>(() => {
    const byProposal = new Map<number, ActionWithProposal[]>()
    for (const a of filteredActions) {
      const list = byProposal.get(a.proposal_id)
      if (list) list.push(a)
      else byProposal.set(a.proposal_id, [a])
    }
    const proposalById = new Map(proposals.map((p) => [p.id, p]))
    const outcomeByProposal = new Map(outcomes.map((o) => [o.proposal_id, o]))

    const result: ProposalGroup[] = []
    for (const [proposalId, groupActions] of byProposal) {
      const proposal = proposalById.get(proposalId)
      if (!proposal) continue
      const lastActivity = groupActions.reduce((max, a) => (a.occurred_at > max ? a.occurred_at : max), groupActions[0].occurred_at)
      result.push({ proposal, outcome: outcomeByProposal.get(proposalId), actions: groupActions, lastActivity })
    }
    return result
  }, [filteredActions, proposals, outcomes])

  const domainFilters = useMemo(
    () => [...new Set(groups.map((g) => g.proposal.domain))].sort().map((d) => ({ text: d, value: d })),
    [groups],
  )

  const { columns, components } = useResizableColumns<ProposalGroup>([
    {
      title: '#',
      width: 70,
      sorter: (a, b) => a.proposal.id - b.proposal.id,
      render: (_, g) => <span className="mono">#{g.proposal.id}</span>,
    },
    {
      title: 'Domain',
      width: 200,
      ellipsis: true,
      sorter: (a, b) => a.proposal.domain.localeCompare(b.proposal.domain),
      filters: domainFilters,
      onFilter: (value, record) => record.proposal.domain === value,
      render: (_, g) => g.proposal.domain,
    },
    {
      title: 'Description',
      ellipsis: true,
      sorter: (a, b) => a.proposal.description.localeCompare(b.proposal.description),
      render: (_, g) => g.proposal.description,
    },
    {
      title: 'Actions',
      width: 90,
      sorter: (a, b) => a.actions.length - b.actions.length,
      render: (_, g) => <Tag>{g.actions.length}</Tag>,
    },
    {
      title: 'Priority',
      width: 110,
      sorter: (a, b) => PRIORITY_RANK[a.proposal.priority] - PRIORITY_RANK[b.proposal.priority],
      filters: (['urgent', 'high', 'normal', 'low'] as Priority[]).map((p) => ({ text: PRIORITY_LABEL[p], value: p })),
      onFilter: (value, record) => record.proposal.priority === value,
      render: (_, g) => <Tag color={PRIORITY_TAG_COLOR[g.proposal.priority]}>{PRIORITY_LABEL[g.proposal.priority]}</Tag>,
    },
    {
      title: 'Schedule',
      width: 170,
      sorter: (a, b) => (a.proposal.next_run_at ?? '').localeCompare(b.proposal.next_run_at ?? ''),
      render: (_, g) =>
        g.proposal.next_run_at ? (
          <span style={{ fontSize: 12 }}>
            {inWords(g.proposal.next_run_at)}
            {g.proposal.recurrence_ms ? ` · ${recurrenceLabel(g.proposal.recurrence_ms)}` : ''}
          </span>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Typography.Text>
        ),
    },
    {
      title: 'Expected',
      width: 190,
      sorter: (a, b) => a.proposal.expected_upside - b.proposal.expected_upside,
      render: (_, g) => (
        <span className="mono" style={{ fontSize: 12 }}>
          ${g.proposal.expected_cost} · {g.proposal.expected_time_hours}h · ${g.proposal.expected_upside}
        </span>
      ),
    },
    {
      title: 'Actual',
      width: 230,
      sorter: (a, b) => (a.outcome?.actual_revenue ?? -Infinity) - (b.outcome?.actual_revenue ?? -Infinity),
      render: (_, g) =>
        g.outcome ? (
          <span className="mono" style={{ fontSize: 12 }}>
            <Tag color={g.outcome.success ? 'success' : 'error'} style={{ marginRight: 4 }}>
              {g.outcome.success ? 'ok' : 'failed'}
            </Tag>
            ${g.outcome.actual_revenue} · ${g.outcome.actual_cost} · {g.outcome.actual_time_hours ?? '—'}h
          </span>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            no outcome yet
          </Typography.Text>
        ),
    },
    {
      title: 'Review',
      width: 180,
      sorter: (a, b) => reviewRank(a.proposal.review_status) - reviewRank(b.proposal.review_status),
      filters: [
        { text: 'Unreviewed', value: 'unreviewed' },
        { text: 'MVP done', value: 'mvp_done' },
        { text: 'Needs refinement', value: 'needs_refinement' },
      ],
      onFilter: (value, record) => (record.proposal.review_status ?? 'unreviewed') === value,
      render: (_, g) => (
        <div onClick={(e) => e.stopPropagation()}>
          <Select<'unreviewed' | 'mvp_done' | 'needs_refinement'>
            size="small"
            style={{ width: 168 }}
            value={g.proposal.review_status ?? 'unreviewed'}
            onChange={(v) => onSetReview(g.proposal.id, v === 'unreviewed' ? null : v)}
            options={REVIEW_OPTIONS}
          />
        </div>
      ),
    },
    {
      title: 'Last activity',
      width: 130,
      sorter: (a, b) => a.lastActivity.localeCompare(b.lastActivity),
      defaultSortOrder: 'descend',
      render: (_, g) => timeAgo(g.lastActivity),
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
          rowKey={(g) => g.proposal.id}
          loading={loading}
          dataSource={groups}
          pagination={{ pageSize: 20 }}
          components={components}
          columns={columns}
          locale={{ emptyText: 'No actions taken on approved proposals yet' }}
          expandable={{
            expandRowByClick: true,
            expandedRowRender: (g) => <ExpandedActions actions={g.actions} onSelect={setSelected} />,
          }}
        />
      </div>
      <ActionDialog action={selected} open={selected !== null} onClose={() => setSelected(null)} />
    </Space>
  )
}
