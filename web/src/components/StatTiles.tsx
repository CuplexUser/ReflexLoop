import { Card, Col, Row, Statistic, Tag } from 'antd'
import type { OutcomeRow, ProposalRow } from '../types'
import { palette } from '../theme'

export function StatTiles({
  proposals,
  outcomes,
  totalCostUsd,
}: {
  proposals: ProposalRow[]
  outcomes: OutcomeRow[]
  totalCostUsd: number
}) {
  const revenue = outcomes.reduce((sum, o) => sum + o.actual_revenue, 0)
  const cost = outcomes.reduce((sum, o) => sum + o.actual_cost, 0)
  const net = revenue - cost

  const counts = { pending: 0, approved: 0, rejected: 0 }
  for (const p of proposals) counts[p.status]++

  return (
    <Row gutter={16}>
      <Col xs={24} sm={12} lg={5}>
        <Card size="small">
          <Statistic
            title="Claude API spend"
            value={totalCostUsd}
            precision={4}
            prefix="$"
            valueStyle={{ color: palette.active, fontSize: 22 }}
          />
        </Card>
      </Col>
      <Col xs={24} sm={12} lg={5}>
        <Card size="small">
          <Statistic title="Reported revenue" value={revenue} precision={2} prefix="$" valueStyle={{ fontSize: 22 }} />
        </Card>
      </Col>
      <Col xs={24} sm={12} lg={5}>
        <Card size="small">
          <Statistic title="Reported cost" value={cost} precision={2} prefix="$" valueStyle={{ fontSize: 22 }} />
        </Card>
      </Col>
      <Col xs={24} sm={12} lg={5}>
        <Card size="small">
          <Statistic
            title="Net (reported)"
            value={net}
            precision={2}
            prefix="$"
            valueStyle={{ color: net >= 0 ? palette.approved : palette.rejected, fontSize: 22 }}
          />
        </Card>
      </Col>
      <Col xs={24} lg={4}>
        <Card size="small" title="Proposals" styles={{ body: { padding: '8px 12px' } }}>
          <Tag color="warning">{counts.pending} pending</Tag>
          <Tag color="success" style={{ marginTop: 6 }}>
            {counts.approved} approved
          </Tag>
          <Tag color="error" style={{ marginTop: 6 }}>
            {counts.rejected} rejected
          </Tag>
        </Card>
      </Col>
    </Row>
  )
}
