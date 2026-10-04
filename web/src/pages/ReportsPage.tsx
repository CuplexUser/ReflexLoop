import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Input, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd'
import type { ReportListRow, ReportVerdict } from '../types'
import { api } from '../api'
import { markdownPreview, matchesQuery, timeAgo } from '../format'
import { CONFIDENCE_TAG, VERDICTS, VERDICT_LABEL, VERDICT_TAG, scoreTag } from '../report'
import { ReportDialog } from '../components/ReportDialog'
import { TableToolbar } from '../components/TableToolbar'
import { useTableView } from '../hooks/useTableView'
import { useTableKeyboardNav } from '../hooks/useTableKeyboardNav'
import { exportCsv, exportJson } from '../export'

const headlineOf = (description: string) => description.split('\n').find((l) => l.trim()) ?? description

/**
 * Every deep-dive report, newest first: what each approved idea came to. This is the page the
 * agent's work now ends on -- the verdict, the score and the summary at a glance, with the full
 * report one click away (deep-linked at /reports/:id like every other detail view).
 */
export function ReportsPage({ historyVersion }: { historyVersion: number }) {
  const navigate = useNavigate()
  const { id } = useParams()
  const [reports, setReports] = useState<ReportListRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [verdict, setVerdict] = useState<ReportVerdict | 'all'>('all')

  useEffect(() => {
    api
      .reports()
      .then(setReports)
      .catch(() => setReports([]))
      .finally(() => setLoading(false))
  }, [historyVersion])

  const selectedId = id ? Number(id) : null
  const openReport = useCallback((r: ReportListRow) => navigate(`/reports/${r.id}`), [navigate])
  const closeReport = useCallback(() => navigate('/reports'), [navigate])

  const filtered = useMemo(
    () =>
      reports
        .filter((r) => verdict === 'all' || r.verdict === verdict)
        .filter((r) => matchesQuery(search, r.id, r.summary, r.proposal_description, r.proposal_domain, r.goal_title)),
    [reports, search, verdict],
  )

  const { rowClassName } = useTableKeyboardNav<ReportListRow>({
    rows: filtered,
    onOpen: openReport,
    enabled: selectedId === null,
  })

  const baseColumns = useMemo(
    () => [
      {
        title: '#',
        dataIndex: 'id',
        width: 70,
        sorter: (a: ReportListRow, b: ReportListRow) => a.id - b.id,
        render: (v: number) => <span className="mono">#{v}</span>,
      },
      {
        title: 'Verdict',
        dataIndex: 'verdict',
        width: 100,
        sorter: (a: ReportListRow, b: ReportListRow) => VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict),
        render: (v: ReportVerdict) => <Tag color={VERDICT_TAG[v]}>{VERDICT_LABEL[v]}</Tag>,
      },
      {
        title: 'Score',
        dataIndex: 'viability_score',
        width: 90,
        sorter: (a: ReportListRow, b: ReportListRow) => a.viability_score - b.viability_score,
        render: (v: number) => <Tag color={scoreTag(v)}>{v}/5</Tag>,
      },
      {
        title: 'Confidence',
        dataIndex: 'confidence',
        width: 110,
        render: (v: ReportListRow['confidence']) => <Tag color={CONFIDENCE_TAG[v]}>{v}</Tag>,
      },
      {
        title: 'Idea',
        dataIndex: 'proposal_description',
        width: 280,
        ellipsis: true,
        render: (v: string, r: ReportListRow) => (
          <span>
            <span className="mono">#{r.proposal_id}</span> {markdownPreview(headlineOf(v), 160)}
          </span>
        ),
      },
      {
        title: 'Summary',
        dataIndex: 'summary',
        ellipsis: true,
      },
      {
        title: 'Goal',
        dataIndex: 'goal_title',
        width: 180,
        ellipsis: true,
        render: (v: string | null, r: ReportListRow) => v ?? <Typography.Text type="secondary">{r.proposal_domain}</Typography.Text>,
      },
      {
        title: 'Filed',
        dataIndex: 'created_at',
        width: 110,
        sorter: (a: ReportListRow, b: ReportListRow) => a.created_at.localeCompare(b.created_at),
        defaultSortOrder: 'descend' as const,
        render: (v: string) => (
          <Tooltip title={new Date(v).toLocaleString()}>
            <span>{timeAgo(v)}</span>
          </Tooltip>
        ),
      },
    ],
    [],
  )

  const { columns, components, scroll, tableProps, view } = useTableView<ReportListRow>('reports', baseColumns)

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space size={12} wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Space size={12} wrap>
          <Input.Search
            allowClear
            placeholder="Search summary, idea, goal, or #12 for an id…"
            style={{ width: 340 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Segmented
            value={verdict}
            onChange={(v) => setVerdict(v as ReportVerdict | 'all')}
            options={[
              { label: 'All', value: 'all' },
              ...VERDICTS.map((v) => ({
                label: `${VERDICT_LABEL[v]} (${reports.filter((r) => r.verdict === v).length})`,
                value: v,
              })),
            ]}
          />
        </Space>
        <TableToolbar
          view={view}
          onExportCsv={() =>
            exportCsv('reports', filtered, [
              { key: 'id', title: '#' },
              { key: 'proposal_id', title: 'Idea #' },
              { key: 'verdict', title: 'Verdict' },
              { key: 'viability_score', title: 'Score' },
              { key: 'confidence', title: 'Confidence' },
              { key: 'summary', title: 'Summary' },
              { key: 'goal_title', title: 'Goal' },
              { key: 'created_at', title: 'Filed' },
            ])
          }
          onExportJson={() => exportJson('reports', filtered)}
        />
      </Space>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={filtered}
        components={components}
        scroll={scroll}
        columns={columns}
        rowClassName={rowClassName}
        locale={{ emptyText: 'No reports yet. Approve an idea and its deep dive files one here.' }}
        onRow={(r) => ({ onClick: () => openReport(r), style: { cursor: 'pointer' } })}
        {...tableProps}
      />

      <ReportDialog reportId={selectedId} onClose={closeReport} />
    </Space>
  )
}
