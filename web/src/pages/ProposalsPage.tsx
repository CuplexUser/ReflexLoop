import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { App, Button, Input, Popconfirm, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import type { OutcomeRow, Priority, ProposalRow } from '../types'
import { api } from '../api'
import { READ_ONLY_HINT, useConsoleOnly } from '../consoleOnly'
import { ProposalDialog } from '../components/ProposalDialog'
import { TableToolbar } from '../components/TableToolbar'
import { PRIORITY_LABEL, PRIORITY_TAG_COLOR, inWords, markdownPreview, recurrenceLabel, timeAgo } from '../format'
import { useTableView } from '../hooks/useTableView'
import { useTableKeyboardNav } from '../hooks/useTableKeyboardNav'
import { exportCsv, exportJson } from '../export'
import { palette } from '../theme'

const STATUS_COLOR: Record<ProposalRow['status'], string> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
}

const PRIORITY_RANK: Record<Priority, number> = { urgent: 3, high: 2, normal: 1, low: 0 }

export function ProposalsPage({ proposals, outcomes }: { proposals: ProposalRow[]; outcomes: OutcomeRow[] }) {
  const { message } = App.useApp()
  const consoleOnly = useConsoleOnly()
  const navigate = useNavigate()
  const { id } = useParams()
  const outcomeByProposal = new Map(outcomes.map((o) => [o.proposal_id, o]))
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [bulkSubmitting, setBulkSubmitting] = useState(false)

  // The dialog is driven by the URL, so a row is a real, shareable location and Back closes it.
  const selected = id ? (proposals.find((p) => p.id === Number(id)) ?? null) : null
  const openProposal = useCallback((p: ProposalRow) => navigate(`/proposals/${p.id}`), [navigate])
  const closeProposal = useCallback(() => navigate('/proposals'), [navigate])

  const domainFilters = useMemo(
    () => [...new Set(proposals.map((p) => p.domain))].sort().map((d) => ({ text: d, value: d })),
    [proposals],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return proposals
    return proposals.filter((p) => `${p.domain} ${p.description}`.toLowerCase().includes(q))
  }, [proposals, search])

  const { focusedIndex, rowClassName } = useTableKeyboardNav<ProposalRow>({
    rows: filtered,
    onOpen: openProposal,
    enabled: selected === null,
  })

  const baseColumns = useMemo(
    () => [
      { title: '#', dataIndex: 'id', width: 70, sorter: (a: ProposalRow, b: ProposalRow) => a.id - b.id },
      {
        title: 'Domain',
        dataIndex: 'domain',
        width: 200,
        ellipsis: true,
        sorter: (a: ProposalRow, b: ProposalRow) => a.domain.localeCompare(b.domain),
        filters: domainFilters,
        onFilter: (value: unknown, record: ProposalRow) => record.domain === value,
      },
      {
        title: 'Description',
        dataIndex: 'description',
        ellipsis: true,
        sorter: (a: ProposalRow, b: ProposalRow) => a.description.localeCompare(b.description),
        render: (v: string) => markdownPreview(v),
      },
      {
        title: 'Status',
        dataIndex: 'status',
        width: 130,
        sorter: (a: ProposalRow, b: ProposalRow) => a.status.localeCompare(b.status),
        filters: [
          { text: 'pending', value: 'pending' },
          { text: 'approved', value: 'approved' },
          { text: 'rejected', value: 'rejected' },
        ],
        onFilter: (value: unknown, record: ProposalRow) => record.status === value,
        render: (status: ProposalRow['status'], p: ProposalRow) => (
          <Space size={4}>
            <Tag color={STATUS_COLOR[status]}>{status}</Tag>
            {/* Age matters only while it's blocking: a pending proposal holds up its act phase. */}
            {status === 'pending' && (
              <Tooltip title={`Awaiting a decision since ${new Date(p.created_at).toLocaleString()}`}>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {timeAgo(p.created_at)}
                </Typography.Text>
              </Tooltip>
            )}
          </Space>
        ),
      },
      {
        title: 'Priority',
        dataIndex: 'priority',
        width: 110,
        sorter: (a: ProposalRow, b: ProposalRow) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
        filters: (['urgent', 'high', 'normal', 'low'] as Priority[]).map((p) => ({ text: PRIORITY_LABEL[p], value: p })),
        onFilter: (value: unknown, record: ProposalRow) => record.priority === value,
        render: (p: Priority) => <Tag color={PRIORITY_TAG_COLOR[p]}>{PRIORITY_LABEL[p]}</Tag>,
      },
      {
        title: 'Schedule',
        width: 170,
        sorter: (a: ProposalRow, b: ProposalRow) => (a.next_run_at ?? '').localeCompare(b.next_run_at ?? ''),
        render: (_: unknown, p: ProposalRow) =>
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
        sorter: (a: ProposalRow, b: ProposalRow) => a.expected_upside - b.expected_upside,
        render: (_: unknown, p: ProposalRow) => (
          <span className="mono" style={{ fontSize: 12 }}>
            ${p.expected_cost} · {p.expected_time_hours}h · ${p.expected_upside}
          </span>
        ),
      },
      {
        title: 'Created',
        dataIndex: 'created_at',
        width: 110,
        sorter: (a: ProposalRow, b: ProposalRow) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        defaultSortOrder: 'descend' as const,
        render: (v: string) => (
          <Tooltip title={new Date(v).toLocaleString()}>
            <span>{timeAgo(v)}</span>
          </Tooltip>
        ),
      },
    ],
    [domainFilters],
  )

  const { columns, components, scroll, tableProps, view } = useTableView<ProposalRow>('proposals', baseColumns)

  const pendingSelected = selectedIds.filter((sid) => proposals.find((p) => p.id === sid)?.status === 'pending')

  async function bulkDecide(approved: boolean) {
    setBulkSubmitting(true)
    try {
      const result = await api.bulkDecide(pendingSelected, approved)
      message.success(
        `${approved ? 'Approved' : 'Rejected'} ${result.decided.length} proposal${result.decided.length === 1 ? '' : 's'}` +
          (result.skipped.length > 0 ? ` · ${result.skipped.length} skipped (no longer pending)` : ''),
      )
      setSelectedIds([])
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Bulk decision failed')
    } finally {
      setBulkSubmitting(false)
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space size={12} wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Input.Search
          allowClear
          placeholder="Search domain or description…"
          style={{ width: 360 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <TableToolbar
          view={view}
          onExportCsv={() =>
            exportCsv('proposals', filtered, [
              { key: 'id', title: '#' },
              { key: 'domain', title: 'Domain' },
              { key: 'description', title: 'Description' },
              { key: 'status', title: 'Status' },
              { key: 'priority', title: 'Priority' },
              { key: 'expected_cost', title: 'Expected cost' },
              { key: 'expected_time_hours', title: 'Expected hours' },
              { key: 'expected_upside', title: 'Expected upside' },
              { key: 'required_tools', title: 'Required tools' },
              { key: 'created_at', title: 'Created' },
              { key: 'decided_at', title: 'Decided' },
            ])
          }
          onExportJson={() => exportJson('proposals', filtered)}
        />
      </Space>

      {pendingSelected.length > 0 && (
        <Space
          size={12}
          wrap
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            background: palette.bgRaised,
            border: `1px solid ${palette.border}`,
          }}
        >
          <Typography.Text>
            {pendingSelected.length} pending proposal{pendingSelected.length === 1 ? '' : 's'} selected
          </Typography.Text>
          <Popconfirm
            title={`Approve ${pendingSelected.length} proposal${pendingSelected.length === 1 ? '' : 's'}?`}
            description="Each runs with default priority and no schedule. To edit scope, open one individually."
            disabled={consoleOnly}
            onConfirm={() => bulkDecide(true)}
          >
            <Tooltip title={consoleOnly ? READ_ONLY_HINT : undefined}>
              <Button
                type="primary"
                size="small"
                icon={<CheckCircleOutlined />}
                loading={bulkSubmitting}
                disabled={consoleOnly}
                style={consoleOnly ? undefined : { background: palette.approved, borderColor: palette.approved }}
              >
                Approve all
              </Button>
            </Tooltip>
          </Popconfirm>
          <Popconfirm
            title={`Reject ${pendingSelected.length} proposal${pendingSelected.length === 1 ? '' : 's'}?`}
            disabled={consoleOnly}
            onConfirm={() => bulkDecide(false)}
          >
            <Tooltip title={consoleOnly ? READ_ONLY_HINT : undefined}>
              <Button danger ghost size="small" icon={<CloseCircleOutlined />} loading={bulkSubmitting} disabled={consoleOnly}>
                Reject all
              </Button>
            </Tooltip>
          </Popconfirm>
          <Button size="small" type="link" onClick={() => setSelectedIds([])}>
            Clear
          </Button>
        </Space>
      )}

      <Table
        rowKey="id"
        dataSource={filtered}
        components={components}
        scroll={scroll}
        columns={columns}
        rowClassName={rowClassName}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as number[]),
          getCheckboxProps: (p) => ({ disabled: p.status !== 'pending' }),
        }}
        onRow={(p) => ({ onClick: () => openProposal(p), style: { cursor: 'pointer' } })}
        {...tableProps}
      />

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {focusedIndex >= 0 ? 'Enter opens the highlighted row · ' : ''}j/k or ↑/↓ to move · Cmd-K to search everything
      </Typography.Text>

      <ProposalDialog
        proposal={selected}
        outcome={selected ? outcomeByProposal.get(selected.id) : undefined}
        open={selected !== null}
        onClose={closeProposal}
      />
    </Space>
  )
}
