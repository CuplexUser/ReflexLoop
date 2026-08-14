import { Card, Col, Row, Statistic, Tag, Tooltip } from 'antd'
import type { OutcomeRow, ProposalRow } from '../types'
import { money } from '../format'
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
  const reportedCost = outcomes.reduce((sum, o) => sum + o.actual_cost, 0)
  // Model API spend counts against profit by design, so the headline number nets it out rather
  // than showing revenue and spend side by side and leaving the subtraction to the reader.
  const net = revenue - reportedCost - totalCostUsd

  const counts = { pending: 0, approved: 0, rejected: 0 }
  for (const p of proposals) counts[p.status]++

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} sm={12} lg={6}>
        <Card size="small">
          <Tooltip
            title={`Revenue reported by the agent, minus its reported cost, minus model API spend. ${money(revenue)} − ${money(reportedCost)} − ${money(totalCostUsd)}. See Economics for the breakdown.`}
          >
            <Statistic
              title="Net"
              value={net}
              precision={2}
              prefix="$"
              valueStyle={{ color: net >= 0 ? palette.approved : palette.rejected, fontSize: 22 }}
            />
          </Tooltip>
        </Card>
      </Col>
      <Col xs={24} sm={12} lg={5}>
        <Card size="small">
          <Statistic title="Reported revenue" value={revenue} precision={2} prefix="$" valueStyle={{ fontSize: 22 }} />
        </Card>
      </Col>
      <Col xs={24} sm={12} lg={5}>
        <Card size="small">
          <Statistic title="Reported cost" value={reportedCost} precision={2} prefix="$" valueStyle={{ fontSize: 22 }} />
        </Card>
      </Col>
      <Col xs={24} sm={12} lg={4}>
        <Card size="small">
          <Statistic
            title="Model API spend"
            value={totalCostUsd}
            precision={4}
            prefix="$"
            valueStyle={{ color: palette.active, fontSize: 22 }}
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
