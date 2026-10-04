import { Card, Col, Row, Statistic, Tag, Tooltip } from 'antd'
import type { ProposalRow } from '../types'
import { money } from '../format'
import { VERDICTS, VERDICT_LABEL, VERDICT_TAG } from '../report'
import { palette } from '../theme'

/**
 * The Dashboard's headline numbers: where the ideas stand, what the deep dives concluded, and
 * what the research has cost. Verdicts come from each idea's latest report, which
 * GET /api/proposals already attaches, so this needs no fetch of its own.
 */
export function StatTiles({ proposals, totalCostUsd }: { proposals: ProposalRow[]; totalCostUsd: number }) {
  const counts = { pending: 0, approved: 0, rejected: 0 }
  for (const p of proposals) counts[p.status]++

  const verdicts = { pursue: 0, maybe: 0, drop: 0 }
  for (const p of proposals) if (p.latest_report) verdicts[p.latest_report.verdict]++
  const reported = verdicts.pursue + verdicts.maybe + verdicts.drop

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} md={8}>
        <Card size="small" title="Ideas" styles={{ body: { padding: '8px 12px' } }}>
          <Tag color="warning">{counts.pending} pending</Tag>
          <Tag color="success">{counts.approved} approved</Tag>
          <Tag color="error">{counts.rejected} rejected</Tag>
        </Card>
      </Col>
      <Col xs={24} md={8}>
        <Card
          size="small"
          title={`Deep-dive verdicts (${reported})`}
          styles={{ body: { padding: '8px 12px' } }}
        >
          {VERDICTS.map((v) => (
            <Tag key={v} color={VERDICT_TAG[v]}>
              {verdicts[v]} {VERDICT_LABEL[v].toLowerCase()}
            </Tag>
          ))}
        </Card>
      </Col>
      <Col xs={24} md={8}>
        <Card size="small">
          <Tooltip
            title={
              reported > 0
                ? `About ${money(totalCostUsd / reported)} per report, if every phase's spend is charged to the reports. See Economics for the breakdown.`
                : 'Every phase is billed: research, deep dives and reflection. See Economics for the breakdown.'
            }
          >
            <Statistic
              title="Model API spend"
              value={totalCostUsd}
              precision={4}
              prefix="$"
              valueStyle={{ color: palette.active, fontSize: 22 }}
            />
          </Tooltip>
        </Card>
      </Col>
    </Row>
  )
}
