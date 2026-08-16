import { useEffect, useMemo, useState } from 'react'
import { Card, Col, Empty, Row, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import type { DomainScore, EconomicsResponse, ModelSpend, OutcomeRow, ProposalRow } from '../types'
import { api } from '../api'
import { money } from '../format'
import { palette } from '../theme'
import { PHASE_LABEL } from '../format'
import { TableToolbar } from '../components/TableToolbar'
import { useTableView } from '../hooks/useTableView'
import { exportCsv, exportJson } from '../export'
import {
  buildFunnel,
  buildProspectRows,
  firstDollarStats,
  monetizationCoverage,
  revenueModelMix,
  type FunnelStage,
  type ProspectRow,
} from '../monetization'
import { MonetizationSteer, type SteerSeed } from '../components/MonetizationSteer'

/**
 * A bar per day, drawn from divs rather than a chart library — the series is a couple of dozen
 * points and the page already loads a megabyte of Ant Design.
 */
function SpendSparkbars({ data }: { data: { day: string; cost_usd: number }[] }) {
  const max = Math.max(...data.map((d) => d.cost_usd), 0.0001)
  if (data.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No runs recorded yet" />

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120 }}>
      {data.map((d) => (
        <Tooltip key={d.day} title={`${d.day} · ${money(d.cost_usd)}`}>
          <div
            style={{
              flex: 1,
              minWidth: 4,
              height: `${Math.max(2, (d.cost_usd / max) * 100)}%`,
              background: palette.active,
              borderRadius: '2px 2px 0 0',
              opacity: 0.85,
            }}
          />
        </Tooltip>
      ))}
    </div>
  )
}

/**
 * `runs` only started recording provider/model partway through, and the column is nullable, so
 * rows from before that have neither. Labelling them as whatever is configured now would credit
 * one provider with another's spend — they get their own name instead.
 */
function modelLabel(row: ModelSpend): { provider: string; model: string } {
  return {
    provider: row.provider ?? 'unrecorded provider',
    model: row.model ?? 'model not recorded',
  }
}

/** Revenue vs the model's own forecast for the same proposals — how well it predicts its upside. */
function forecastAccuracy(row: DomainScore): { label: string; color: string } {
  if (row.outcomes === 0 || row.forecast_upside === 0) return { label: '—', color: palette.textMuted }
  const ratio = row.revenue / row.forecast_upside
  const pct = Math.round(ratio * 100)
  if (ratio >= 0.8) return { label: `${pct}% of forecast`, color: palette.approved }
  if (ratio >= 0.4) return { label: `${pct}% of forecast`, color: palette.pending }
  return { label: `${pct}% of forecast`, color: palette.rejected }
}

/**
 * `proposal_create` describes expectedUpside to the model only as "Expected revenue or value if it
 * works" -- it pins no period, no lifetime and not even a currency (its sibling expectedCost says
 * "in your currency of choice"). So every total built on it is a sum of claims, not a projection,
 * and saying so is the difference between a figure a reader can weigh and one they'll over-trust.
 */
const CLAIMED_UPSIDE_NOTE =
  'Self-reported and unitless. proposal_create describes expectedUpside to the model only as ' +
  '"Expected revenue or value if it works" — no period, no lifetime, no currency. These are claims ' +
  'summed as filed, shown in dollars for consistency with the tiles above, not because the tool ' +
  'enforces one.'

/**
 * The pipeline as a funnel: one tapering bar per stage. Same div-drawn approach as SpendSparkbars
 * above -- four bars don't justify a charting library any more than a couple of dozen days did.
 *
 * Width is share by *count*, and the money for each stage is printed beside it rather than drawn,
 * because the two series genuinely move apart (a proposal can be acted on and claim $0) and drawing
 * only one of them would flatter or damn the loop depending on which.
 */
function FunnelBars({ stages }: { stages: FunnelStage[] }) {
  const max = stages[0]?.count ?? 0

  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {stages.map((stage) => {
        const share = max > 0 ? Math.max(0, stage.count / max) : 0
        return (
          <div
            key={stage.key}
            style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%' }}
          >
            <Typography.Text style={{ width: 108, flexShrink: 0, fontSize: 13 }}>
              {stage.label}
            </Typography.Text>
            <div style={{ flex: 1, display: 'flex', justifyContent: 'center', minWidth: 0 }}>
              <Tooltip
                title={
                  stage.zeroUpsideCount > 0
                    ? `${stage.count} proposals · ${stage.zeroUpsideCount} of them claim $0 upside`
                    : `${stage.count} proposals`
                }
              >
                <div
                  style={{
                    width: `${share * 100}%`,
                    minWidth: 44,
                    height: 34,
                    borderRadius: 5,
                    background: stage.count === 0 ? palette.bgSunken : palette.active,
                    border: stage.count === 0 ? `1px dashed ${palette.borderStrong}` : undefined,
                    color: stage.count === 0 ? palette.textMuted : '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 14,
                    fontWeight: 600,
                  }}
                  className="mono"
                >
                  {stage.count}
                </div>
              </Tooltip>
            </div>
            <Tooltip title={CLAIMED_UPSIDE_NOTE}>
              <Typography.Text
                type="secondary"
                className="mono"
                style={{ width: 132, flexShrink: 0, textAlign: 'right', fontSize: 12 }}
              >
                {money(stage.upside)}
              </Typography.Text>
            </Tooltip>
          </div>
        )
      })}
    </Space>
  )
}

const STATUS_TAG: Record<ProposalRow['status'], string> = {
  approved: 'success',
  pending: 'warning',
  rejected: 'error',
}

export function EconomicsPage({
  historyVersion,
  proposals,
  outcomes,
}: {
  historyVersion: number
  proposals: ProposalRow[]
  outcomes: OutcomeRow[]
}) {
  const navigate = useNavigate()
  const [data, setData] = useState<EconomicsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .economics()
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [historyVersion])

  const revenue = outcomes.reduce((sum, o) => sum + o.actual_revenue, 0)
  const reportedCost = outcomes.reduce((sum, o) => sum + o.actual_cost, 0)
  const apiSpend = data?.totalCostUsd ?? 0
  // The number the whole loop is judged on: what it earned, minus what it said it spent,
  // minus what it cost in model API spend to produce any of it. Its three inputs are printed
  // under it, because a lone figure here is one nobody can check against the tiles beside it.
  const net = revenue - reportedCost - apiSpend

  // Spend is lifetime and accumulates across provider switches, so name the providers behind
  // the total rather than implying it all came from whichever one is configured today.
  const providerSummary = useMemo(() => {
    const byProvider = new Map<string, number>()
    for (const row of data?.spendByModel ?? []) {
      const { provider } = modelLabel(row)
      byProvider.set(provider, (byProvider.get(provider) ?? 0) + row.cost_usd)
    }
    return [...byProvider.entries()].sort((a, b) => b[1] - a[1])
  }, [data?.spendByModel])

  // The scoreboard below can only attribute spend that was charged to a proposal; research
  // and planning run before one exists. Stating the remainder is what makes the column and
  // the headline reconcile instead of looking like one of them is wrong.
  const unattributed = data?.unattributedSpend ?? 0
  const attributed = apiSpend - unattributed

  const baseColumns = useMemo(
    () => [
      {
        title: 'Domain',
        dataIndex: 'domain',
        width: 220,
        ellipsis: true,
        sorter: (a: DomainScore, b: DomainScore) => a.domain.localeCompare(b.domain),
      },
      {
        title: 'Proposals',
        dataIndex: 'proposals',
        width: 130,
        sorter: (a: DomainScore, b: DomainScore) => a.proposals - b.proposals,
        render: (_: unknown, r: DomainScore) => (
          <span className="mono" style={{ fontSize: 12 }}>
            {r.approved}/{r.proposals} approved
          </span>
        ),
      },
      {
        title: 'Success rate',
        width: 150,
        sorter: (a: DomainScore, b: DomainScore) =>
          (a.outcomes ? a.successes / a.outcomes : -1) - (b.outcomes ? b.successes / b.outcomes : -1),
        render: (_: unknown, r: DomainScore) =>
          r.outcomes === 0 ? (
            <Typography.Text type="secondary">no outcomes</Typography.Text>
          ) : (
            <Tag color={r.successes / r.outcomes >= 0.5 ? 'success' : 'error'}>
              {r.successes}/{r.outcomes} succeeded
            </Tag>
          ),
      },
      {
        title: 'Revenue',
        dataIndex: 'revenue',
        width: 120,
        sorter: (a: DomainScore, b: DomainScore) => a.revenue - b.revenue,
        render: (v: number) => <span className="mono">{money(v)}</span>,
      },
      {
        title: 'API spend',
        dataIndex: 'api_spend',
        width: 120,
        sorter: (a: DomainScore, b: DomainScore) => a.api_spend - b.api_spend,
        render: (v: number) => <span className="mono">${v.toFixed(4)}</span>,
      },
      {
        title: 'Net',
        width: 120,
        sorter: (a: DomainScore, b: DomainScore) =>
          a.revenue - a.reported_cost - a.api_spend - (b.revenue - b.reported_cost - b.api_spend),
        render: (_: unknown, r: DomainScore) => {
          const value = r.revenue - r.reported_cost - r.api_spend
          return (
            <span className="mono" style={{ color: value >= 0 ? palette.approved : palette.rejected }}>
              {money(value)}
            </span>
          )
        },
      },
      {
        title: 'Forecast accuracy',
        width: 180,
        sorter: (a: DomainScore, b: DomainScore) =>
          (a.forecast_upside ? a.revenue / a.forecast_upside : -1) -
          (b.forecast_upside ? b.revenue / b.forecast_upside : -1),
        render: (_: unknown, r: DomainScore) => {
          const { label, color } = forecastAccuracy(r)
          return (
            <Tooltip title={`Forecast ${money(r.forecast_upside)} · actual ${money(r.revenue)}`}>
              <span style={{ color, fontSize: 12 }}>{label}</span>
            </Tooltip>
          )
        },
      },
    ],
    [],
  )

  const { columns, components, scroll, tableProps, view } = useTableView<DomainScore>('economics', baseColumns, {
    defaultPageSize: 20,
  })

  // Everything below derives from props App already holds -- no fetch, so none of it is gated on
  // `loading`, which belongs to the /api/economics request and would spin over data in hand.
  const funnel = useMemo(() => buildFunnel(proposals, outcomes), [proposals, outcomes])
  const mix = useMemo(() => revenueModelMix(proposals, outcomes), [proposals, outcomes])
  const coverage = useMemo(() => monetizationCoverage(proposals), [proposals])
  const prospects = useMemo(() => buildProspectRows(proposals, outcomes), [proposals, outcomes])
  const firstDollar = useMemo(() => firstDollarStats(prospects), [prospects])

  const prospectColumns = useMemo(
    () => [
      {
        title: '#',
        dataIndex: 'id',
        width: 70,
        sorter: (a: ProspectRow, b: ProspectRow) => a.id - b.id,
        render: (id: number) => <span className="mono">{id}</span>,
      },
      {
        title: 'Status',
        dataIndex: 'status',
        width: 110,
        render: (status: ProspectRow['status']) => <Tag color={STATUS_TAG[status]}>{status}</Tag>,
      },
      {
        title: 'Model',
        dataIndex: 'revenueModelText',
        width: 140,
        render: (label: string) =>
          label ? (
            <Tag color="green">{label}</Tag>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              —
            </Typography.Text>
          ),
      },
      { title: 'Who pays', dataIndex: 'whoPays', width: 190, ellipsis: true },
      {
        title: 'Price point',
        dataIndex: 'pricePoint',
        width: 150,
        ellipsis: true,
        render: (v: string) => <span className="mono">{v}</span>,
      },
      // The one width-less column, so it takes the slack rather than collapsing a neighbour.
      { title: 'Path to first dollar', dataIndex: 'pathToFirstDollar', ellipsis: true },
      {
        title: 'Days to $1',
        dataIndex: 'daysToFirstDollar',
        width: 130,
        defaultSortOrder: 'ascend' as const,
        sorter: (a: ProspectRow, b: ProspectRow) => a.daysToFirstDollar - b.daysToFirstDollar,
        render: (days: number, row: ProspectRow) => (
          <Tooltip
            title={
              row.pastOwnDeadline
                ? `Decided ${row.daysSinceDecision} days ago against its own ${days}-day estimate, with nothing realized. For a proposal with no execution evidence this says the plan did not happen — not that the estimate was wrong.`
                : 'Days from approval, as the proposal itself stated'
            }
          >
            <span className="mono" style={{ color: row.pastOwnDeadline ? palette.rejected : undefined }}>
              {days}d{row.pastOwnDeadline ? ' · overdue' : ''}
            </span>
          </Tooltip>
        ),
      },
      { title: 'Key assumption', dataIndex: 'keyAssumption', width: 240, ellipsis: true },
      { title: 'Validation signal', dataIndex: 'validationSignal', width: 200, ellipsis: true },
      {
        title: 'Steps',
        key: 'steps',
        width: 130,
        sorter: (a: ProspectRow, b: ProspectRow) => a.stepCount - b.stepCount,
        render: (_: unknown, row: ProspectRow) => (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.stepCount} · {row.humanStepCount} need you
          </Typography.Text>
        ),
      },
      {
        title: 'Claimed',
        dataIndex: 'expectedUpside',
        width: 130,
        sorter: (a: ProspectRow, b: ProspectRow) => a.expectedUpside - b.expectedUpside,
        render: (v: number) => (
          <Tooltip title={CLAIMED_UPSIDE_NOTE}>
            <span className="mono">{money(v)}</span>
          </Tooltip>
        ),
      },
      {
        title: 'Realized',
        dataIndex: 'actualRevenue',
        width: 130,
        // -1 sentinel so "no outcome" sorts below $0, matching the other tables on this page.
        sorter: (a: ProspectRow, b: ProspectRow) => (a.actualRevenue ?? -1) - (b.actualRevenue ?? -1),
        render: (v: number | null) =>
          v === null ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              no outcome
            </Typography.Text>
          ) : (
            <span className="mono">{money(v)}</span>
          ),
      },
    ],
    [],
  )

  // A second view, keyed apart from 'economics' above -- useTableView is parameterised entirely by
  // its storage key, so the two tables keep independent widths, columns, density and page size.
  const prospectView = useTableView<ProspectRow>('economics-prospects', prospectColumns, {
    defaultPageSize: 10,
  })

  // Seeds are drawn from findings that are actually true right now, so the card offers nothing the
  // page isn't currently showing evidence for -- an empty seed list is the correct state when the
  // loop is behaving.
  const steerSeeds = useMemo(() => {
    const seeds: SteerSeed[] = []
    const [proposed, , acted] = funnel.stages

    if (funnel.approvedNoEvidence.count > 0) {
      seeds.push({
        source: 'Pipeline',
        label: `${money(funnel.approvedNoEvidence.upside)} approved, never acted on`,
        text: `${funnel.approvedNoEvidence.count} approved proposals (${funnel.approvedNoEvidence.ids
          .map((id) => `#${id}`)
          .join(', ')}) have no execution evidence at all. Before proposing anything new in those lanes, check why they never ran.`,
      })
    }
    if (proposed.upside > 0 && funnel.realized === 0 && acted.count > 0) {
      seeds.push({
        source: 'Pipeline',
        label: 'claimed far ahead of realized',
        text: `${money(proposed.upside)} of claimed upside is on record against ${money(funnel.realized)} realized. Prefer proposals with a path to first dollar under 30 days, even where the claimed upside is smaller.`,
      })
    }
    for (const slice of mix.slices) {
      if (slice.count >= 2 && slice.realized === 0) {
        seeds.push({
          source: 'Pathways',
          label: `${slice.label} never converts`,
          text: `${slice.count} ${slice.label.toLowerCase()} proposals have been filed and none has reached a first dollar. Prefer models where the buyer is identifiable, or state what would have to be true for this one to work.`,
        })
      }
    }
    if (firstDollar.pastOwnDeadline > 0) {
      seeds.push({
        source: 'Prospects',
        label: `${firstDollar.pastOwnDeadline} past its own deadline`,
        text: `${firstDollar.pastOwnDeadline} approved proposals are past the daysToFirstDollar they stated themselves, with no revenue recorded. Be more conservative with that estimate, and say what the slowest step is.`,
      })
    }
    return seeds
  }, [funnel, mix, firstDollar])

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        {/* Both of these are the agent's own claims, not measurements -- nothing in the system
            observes real money. Saying so on the tile matters more than it looks: they are two
            of the three inputs to Net, and the third (API spend) *is* measured, so a reader who
            assumes they're all the same kind of number will over-trust the result. */}
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Tooltip
              title={`Self-reported: the sum of actualRevenue across ${outcomes.length} outcome${outcomes.length === 1 ? '' : 's'} the agent recorded via outcome_record at the end of an act phase. No payment processor is connected, so nothing here is measured.`}
            >
              <Statistic
                title="Reported revenue"
                value={revenue}
                precision={2}
                prefix="$"
                valueStyle={{ fontSize: 22 }}
              />
            </Tooltip>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Tooltip title="Self-reported: external costs the agent says the work incurred (hosting, services). Model API spend is measured separately and is the tile to the right.">
              <Statistic
                title="Reported cost"
                value={reportedCost}
                precision={2}
                prefix="$"
                valueStyle={{ fontSize: 22 }}
              />
            </Tooltip>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title="Model API spend"
              value={apiSpend}
              precision={4}
              prefix="$"
              valueStyle={{ color: palette.active, fontSize: 22 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {providerSummary.length === 0
                ? 'no runs recorded yet'
                : providerSummary.map(([provider, cost]) => `${provider} ${money(cost)}`).join(' · ')}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title="Net"
              value={net}
              precision={2}
              prefix="$"
              valueStyle={{ color: net >= 0 ? palette.approved : palette.rejected, fontSize: 22 }}
            />
            <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>
              {money(revenue)} revenue − {money(reportedCost)} cost − {money(apiSpend)} API spend
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24}>
          <Card size="small" title="Daily model API spend" loading={loading}>
            <SpendSparkbars data={data?.spendOverTime ?? []} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="Spend by phase" loading={loading}>
            {(data?.spendByPhase ?? []).length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No runs recorded yet" />
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {data?.spendByPhase.map((p) => (
                  <Space key={p.phase} style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Typography.Text>{PHASE_LABEL[p.phase] ?? p.phase}</Typography.Text>
                    <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>
                      {p.runs} run{p.runs === 1 ? '' : 's'} · ${p.cost_usd.toFixed(4)} ·{' '}
                      {(p.duration_ms / 60000).toFixed(1)}m
                    </Typography.Text>
                  </Space>
                ))}
              </Space>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          {/* Spend is lifetime, and the provider is a config switch -- this is where a total
              that looks too big becomes explicable, by showing which provider and which era
              of runs it actually came from. */}
          <Card size="small" title="Spend by model" loading={loading}>
            {(data?.spendByModel ?? []).length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No runs recorded yet" />
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {data?.spendByModel.map((m) => {
                  const { provider, model } = modelLabel(m)
                  const unknown = m.provider === null
                  return (
                    <Space
                      key={`${m.provider ?? '?'}/${m.model ?? '?'}`}
                      style={{ width: '100%', justifyContent: 'space-between' }}
                    >
                      <Tooltip
                        title={
                          unknown
                            ? `${m.runs} run${m.runs === 1 ? '' : 's'} recorded before the provider/model was tracked, ${m.first_at.slice(0, 10)} to ${m.last_at.slice(0, 10)}`
                            : `${m.first_at.slice(0, 10)} to ${m.last_at.slice(0, 10)}`
                        }
                      >
                        <Typography.Text style={{ color: unknown ? palette.textMuted : undefined }}>
                          {provider}
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {' '}
                            · {model}
                          </Typography.Text>
                        </Typography.Text>
                      </Tooltip>
                      <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>
                        {m.runs} run{m.runs === 1 ? '' : 's'} · ${m.cost_usd.toFixed(4)}
                      </Typography.Text>
                    </Space>
                  )
                })}
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <div>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }} wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>
            By domain
          </Typography.Title>
          <TableToolbar
            view={view}
            onExportCsv={() =>
              exportCsv('domain-scoreboard', data?.domains ?? [], [
                { key: 'domain', title: 'Domain' },
                { key: 'proposals', title: 'Proposals' },
                { key: 'approved', title: 'Approved' },
                { key: 'outcomes', title: 'Outcomes' },
                { key: 'successes', title: 'Successes' },
                { key: 'revenue', title: 'Revenue' },
                { key: 'reported_cost', title: 'Reported cost' },
                { key: 'api_spend', title: 'API spend' },
                { key: 'forecast_upside', title: 'Forecast upside' },
              ])
            }
            onExportJson={() => exportJson('domain-scoreboard', data?.domains ?? [])}
          />
        </Space>
        <Table
          rowKey="domain"
          loading={loading}
          dataSource={data?.domains ?? []}
          components={components}
          scroll={scroll}
          columns={columns}
          locale={{ emptyText: 'No proposals yet' }}
          {...tableProps}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          The API spend column adds up to {money(attributed)} of {money(apiSpend)}. The other{' '}
          {money(unattributed)} is research and planning, which runs before any proposal exists and so
          belongs to no domain — it still counts against Net.
        </Typography.Text>
      </div>

      {/* ---- Monetization: what the agent is trying to earn on, and by what mechanism ---------
          Two halves with different provenance, and they must not be confused. The funnel reads
          fields every proposal has and is useful immediately; the pathway and prospect blocks read
          the columns added after every existing proposal was written, and say so when empty rather
          than rendering a zero that reads as a measurement. */}
      <Typography.Title level={5} style={{ margin: '4px 0 0' }}>
        Monetization pathways
      </Typography.Title>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card
            size="small"
            title="Pipeline"
            extra={
              <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>
                {funnel.totalProposals} proposals · {funnel.outcomeRows} outcome
                {funnel.outcomeRows === 1 ? '' : 's'}
              </Typography.Text>
            }
          >
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <FunnelBars stages={funnel.stages} />

              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {funnel.actedEvidence.withOutcome} recorded an outcome ·{' '}
                <Tooltip title="outcome_record is a model call at the end of the act phase, so a crashed or abandoned phase leaves no row. A human review verdict is the other evidence that real work exists.">
                  <span>{funnel.actedEvidence.reviewedOnly} carry a human review verdict without one</span>
                </Tooltip>
              </Typography.Text>

              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  <strong>{funnel.rejected.count}</strong> rejected · {money(funnel.rejected.upside)}{' '}
                  claimed, not pursued
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  <strong>{funnel.pending.count}</strong> pending · {money(funnel.pending.upside)}{' '}
                  awaiting a decision
                </Typography.Text>
                {funnel.approvedNoEvidence.count > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    <strong>{funnel.approvedNoEvidence.count}</strong> approved with no evidence ·{' '}
                    {money(funnel.approvedNoEvidence.upside)} (
                    {funnel.approvedNoEvidence.ids.map((id) => `#${id}`).join(', ')})
                  </Typography.Text>
                )}
              </Space>

              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {funnel.stages[1].count} approved + {funnel.rejected.count} rejected +{' '}
                {funnel.pending.count} pending = {funnel.totalProposals}. Claimed upside is
                self-reported and unitless.
              </Typography.Text>
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card size="small" title="Pathways">
            {mix.slices.length === 0 ? (
              <Space direction="vertical" size={6}>
                <Typography.Text strong>No proposal states a revenue model yet.</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {mix.unclassified} of {mix.total} proposals predate this field — it was added to the
                  proposals table after every proposal on record was written, and no research cycle has
                  run since. <span className="mono">proposal_create</span> now requires it, so this
                  fills in on its own from the next cycle. Nothing is missing from the figures beside it.
                </Typography.Text>
              </Space>
            ) : (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {mix.slices.map((slice) => (
                  <div key={slice.model}>
                    <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                      <Typography.Text style={{ fontSize: 13 }}>{slice.label}</Typography.Text>
                      <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>
                        {slice.count} · {money(slice.upside)} claimed
                        {slice.realized > 0 ? ` · ${money(slice.realized)} realized` : ''}
                      </Typography.Text>
                    </Space>
                    {/* Length is share by count only. Drawing claimed upside as a length would
                        assert two proposals' claims are comparable quantities; they aren't. */}
                    <Tooltip title={`${slice.count} of ${mix.classified} classified proposals`}>
                      <div style={{ height: 5, borderRadius: 3, background: palette.bgSunken }}>
                        <div
                          style={{
                            width: `${Math.max(0, slice.count / mix.classified) * 100}%`,
                            height: '100%',
                            borderRadius: 3,
                            background: palette.active,
                          }}
                        />
                      </div>
                    </Tooltip>
                  </div>
                ))}
                {mix.unclassified > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {mix.unclassified} of {mix.total} proposals state no revenue model and are in no
                    row — the counts above add to {mix.classified}, not {mix.total}.
                  </Typography.Text>
                )}
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <div>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }} wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Prospects
          </Typography.Title>
          <TableToolbar
            view={prospectView.view}
            onExportCsv={() =>
              exportCsv('prospects', prospects, [
                { key: 'id', title: 'Proposal' },
                { key: 'status', title: 'Status' },
                { key: 'revenueModelText', title: 'Revenue model' },
                { key: 'whoPays', title: 'Who pays' },
                { key: 'pricePoint', title: 'Price point' },
                { key: 'pathToFirstDollar', title: 'Path to first dollar' },
                { key: 'daysToFirstDollar', title: 'Days to first dollar' },
                { key: 'keyAssumption', title: 'Key assumption' },
                { key: 'validationSignal', title: 'Validation signal' },
                { key: 'expectedUpside', title: 'Claimed upside' },
                { key: 'actualRevenue', title: 'Realized revenue' },
              ])
            }
            onExportJson={() => exportJson('prospects', prospects)}
          />
        </Space>
        <Table
          rowKey="id"
          dataSource={prospects}
          components={prospectView.components}
          scroll={prospectView.scroll}
          columns={prospectView.columns}
          onRow={(row) => ({ onClick: () => navigate(`/proposals/${row.id}`) })}
          locale={{
            emptyText: `No proposal carries a monetization block yet — ${coverage.predateField} of ${coverage.total} were filed before proposal_create required one.`,
          }}
          {...prospectView.tableProps}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          {firstDollar.n === 0
            ? 'No proposal states a time to first dollar yet — daysToFirstDollar lives inside the monetization block.'
            : firstDollar.median === null
              ? `Time to first dollar: ${firstDollar.values.map((v) => `${v}d`).join(' · ')} (median needs 4 proposals; a median of two is an invented midpoint).`
              : `Median ${firstDollar.median}d to first dollar · range ${firstDollar.min}–${firstDollar.max}d across ${firstDollar.n} proposals.`}
          {firstDollar.pastOwnDeadline > 0 && (
            <>
              {' '}
              <span style={{ color: palette.rejected }}>
                {firstDollar.pastOwnDeadline} past the day count it stated itself
              </span>
              , with no revenue recorded.
            </>
          )}{' '}
          Listing {coverage.withBlock} of {coverage.total} proposals; {coverage.predateField} predate
          the monetization block
          {coverage.unreadable > 0
            ? `, ${coverage.unreadable} store one that could not be parsed`
            : ''}
          .
        </Typography.Text>
      </div>

      <MonetizationSteer seeds={steerSeeds} historyVersion={historyVersion} />
    </Space>
  )
}
