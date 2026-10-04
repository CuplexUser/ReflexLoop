import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Collapse, Empty, Skeleton, Space, Table, Tag, Typography } from 'antd'
import type { GoalLandscape as Landscape, ProposalRow, ReportSummary } from '../types'
import { api } from '../api'
import { markdownPreview, timeAgo } from '../format'
import { VERDICT_LABEL, VERDICT_TAG, scoreTag } from '../report'
import { useTableView } from '../hooks/useTableView'

/** Section headings for each note kind, in the order the server already sorted them. */
const KIND_LABEL: Record<string, string> = {
  gap: 'Opportunities — gaps found',
  demand: 'Demand evidence',
  market_size: 'Market size',
  competitor: 'Competitors',
  pricing: 'Pricing',
  risk: 'Risks',
  saturated: 'Already saturated — ruled out',
  unclassified: 'Other notes',
}

const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ')

type IdeaRow = Landscape['ideas'][number]

const headlineOf = (p: ProposalRow) => p.description.split('\n').find((l) => l.trim()) ?? p.description

/**
 * One goal's market, assembled from what the record already holds: the ideas filed under it
 * with their research scores and deep-dive verdicts, the competitors those ideas named, and the
 * research notes grouped by what kind of finding each is. Derived on read -- nothing here is
 * written by the agent as a summary, so it can't drift from the notes and reports it shows.
 */
export function GoalLandscape({ goalId }: { goalId: number }) {
  const navigate = useNavigate()
  const [data, setData] = useState<Landscape | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    api
      .goalLandscape(goalId)
      .then((d) => !cancelled && setData(d))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [goalId])

  const columns = useMemo(
    () => [
      {
        title: '#',
        width: 64,
        render: (_: unknown, r: IdeaRow) => <span className="mono">#{r.proposal.id}</span>,
      },
      {
        title: 'Idea',
        ellipsis: true,
        render: (_: unknown, r: IdeaRow) => markdownPreview(headlineOf(r.proposal), 140),
      },
      {
        title: 'Status',
        width: 100,
        render: (_: unknown, r: IdeaRow) => <Tag>{r.proposal.status}</Tag>,
      },
      {
        title: 'Research',
        width: 100,
        sorter: (a: IdeaRow, b: IdeaRow) => (a.market?.viabilityScore ?? 0) - (b.market?.viabilityScore ?? 0),
        render: (_: unknown, r: IdeaRow) =>
          r.market ? <Tag color={scoreTag(r.market.viabilityScore)}>{r.market.viabilityScore}/5</Tag> : '—',
      },
      {
        title: 'Deep dive',
        width: 140,
        render: (_: unknown, r: IdeaRow) => <VerdictCell report={r.report} />,
      },
    ],
    [],
  )
  const ideasView = useTableView<IdeaRow>('goal-landscape-ideas', columns)

  if (error) return <Alert type="error" showIcon message="Could not load this goal's landscape" description={error} />
  if (!data) return <Skeleton active paragraph={{ rows: 6 }} />

  const { counts } = data
  // Navigating away unmounts the goal page, and the dialog with it -- nothing to close first.
  const openNote = (id: number) => navigate(`/research/${id}`)

  return (
    <Space direction="vertical" size={18} style={{ width: '100%' }}>
      <Space size={[6, 6]} wrap>
        <Tag>{counts.ideas} ideas</Tag>
        <Tag>{counts.notes} research notes</Tag>
        {counts.pursue > 0 && <Tag color={VERDICT_TAG.pursue}>{counts.pursue} pursue</Tag>}
        {counts.maybe > 0 && <Tag color={VERDICT_TAG.maybe}>{counts.maybe} maybe</Tag>}
        {counts.drop > 0 && <Tag color={VERDICT_TAG.drop}>{counts.drop} drop</Tag>}
      </Space>

      {counts.ideas === 0 && counts.notes === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Nothing filed under this goal yet. The landscape fills in as research cycles save notes and ideas against it."
        />
      ) : (
        <>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              IDEAS AND WHAT THEY CAME TO
            </Typography.Text>
            <Table
              style={{ marginTop: 6 }}
              rowKey={(r) => r.proposal.id}
              size="small"
              pagination={false}
              dataSource={data.ideas}
              columns={ideasView.columns}
              components={ideasView.components}
              scroll={ideasView.scroll}
              locale={{ emptyText: 'No ideas filed under this goal yet.' }}
              onRow={(r) => ({
                onClick: () => navigate(`/proposals/${r.proposal.id}`),
                style: { cursor: 'pointer' },
              })}
            />
          </div>

          {data.competitors.length > 0 && (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                COMPETITORS NAMED ACROSS THESE IDEAS
              </Typography.Text>
              <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                {data.competitors.map((c) => (
                  <li key={c.name} style={{ marginBottom: 4 }}>
                    {c.url ? (
                      <Typography.Link href={c.url} target="_blank" rel="noopener noreferrer">
                        {c.name}
                      </Typography.Link>
                    ) : (
                      <Typography.Text strong>{c.name}</Typography.Text>
                    )}
                    {c.pricing && <Typography.Text type="secondary"> · {c.pricing}</Typography.Text>}
                    {c.gap && <Typography.Text> · gap: {c.gap}</Typography.Text>}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {' '}
                      (named by {c.ideaIds.map((id) => `#${id}`).join(', ')})
                    </Typography.Text>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.notes.length > 0 && (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                RESEARCH NOTES, BY KIND
              </Typography.Text>
              <Collapse
                size="small"
                style={{ marginTop: 6 }}
                // Open ground expanded, dead ends and the unsorted remainder folded away.
                defaultActiveKey={data.notes.filter((g) => g.kind !== 'saturated' && g.kind !== 'unclassified').map((g) => g.kind)}
                items={data.notes.map((group) => ({
                  key: group.kind,
                  label: (
                    <span>
                      {kindLabel(group.kind)}{' '}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        ({group.notes.length})
                      </Typography.Text>
                    </span>
                  ),
                  children: (
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      {group.notes.map((n) => (
                        <div key={n.id}>
                          <Typography.Link onClick={() => openNote(n.id)}>
                            #{n.id} {n.topic}
                          </Typography.Link>{' '}
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {timeAgo(n.fetched_at)}
                          </Typography.Text>
                          <div style={{ fontSize: 12 }}>{markdownPreview(n.finding, 200)}</div>
                        </div>
                      ))}
                    </Space>
                  ),
                }))}
              />
            </div>
          )}
        </>
      )}

      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        Only what is filed under this goal. Notes saved before goals existed are unassigned and don't appear here;
        search for them on Research notes.
      </Typography.Text>
    </Space>
  )
}

function VerdictCell({ report }: { report: ReportSummary | null }) {
  if (!report) return <Typography.Text type="secondary">—</Typography.Text>
  return (
    <Link to={`/reports/${report.id}`} onClick={(e) => e.stopPropagation()}>
      <Tag color={VERDICT_TAG[report.verdict]} style={{ cursor: 'pointer' }}>
        {VERDICT_LABEL[report.verdict]} {report.viability_score}/5
      </Tag>
    </Link>
  )
}
