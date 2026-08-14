import { useEffect, useMemo, useState } from 'react'
import { Card, Col, Empty, Row, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd'
import type { DomainScore, EconomicsResponse, OutcomeRow } from '../types'
import { api } from '../api'
import { money } from '../format'
import { palette } from '../theme'
import { PHASE_LABEL } from '../format'
import { TableToolbar } from '../components/TableToolbar'
import { useTableView } from '../hooks/useTableView'
import { exportCsv, exportJson } from '../export'

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

/** Revenue vs the model's own forecast for the same proposals — how well it predicts its upside. */
function forecastAccuracy(row: DomainScore): { label: string; color: string } {
  if (row.outcomes === 0 || row.forecast_upside === 0) return { label: '—', color: palette.textMuted }
  const ratio = row.revenue / row.forecast_upside
  const pct = Math.round(ratio * 100)
  if (ratio >= 0.8) return { label: `${pct}% of forecast`, color: palette.approved }
  if (ratio >= 0.4) return { label: `${pct}% of forecast`, color: palette.pending }
  return { label: `${pct}% of forecast`, color: palette.rejected }
}

export function EconomicsPage({ historyVersion, outcomes }: { historyVersion: number; outcomes: OutcomeRow[] }) {
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
  // minus what it cost in Claude API spend to produce any of it.
  const net = revenue - reportedCost - apiSpend

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

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic title="Reported revenue" value={revenue} precision={2} prefix="$" valueStyle={{ fontSize: 22 }} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic title="Reported cost" value={reportedCost} precision={2} prefix="$" valueStyle={{ fontSize: 22 }} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title="Claude API spend"
              value={apiSpend}
              precision={4}
              prefix="$"
              valueStyle={{ color: palette.active, fontSize: 22 }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title="Net (revenue − cost − spend)"
              value={net}
              precision={2}
              prefix="$"
              valueStyle={{ color: net >= 0 ? palette.approved : palette.rejected, fontSize: 22 }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card size="small" title="Daily Claude API spend" loading={loading}>
            <SpendSparkbars data={data?.spendOverTime ?? []} />
          </Card>
        </Col>
        <Col xs={24} lg={10}>
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
      </div>
    </Space>
  )
}
