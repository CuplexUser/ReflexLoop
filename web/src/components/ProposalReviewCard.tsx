import { Card, Space, Statistic, Tag, Tooltip, Typography } from 'antd'
import { WarningOutlined } from '@ant-design/icons'
import type { ProposalRow } from '../types'
import { palette } from '../theme'
import { timeAgo } from '../format'
import { MarkdownLite } from './MarkdownLite'
import { MonetizationSummary } from './MonetizationBlock'
import { MarketSummary } from './MarketBlock'
import { DecisionControls } from './DecisionControls'

const { Title, Text } = Typography

export function ProposalReviewCard({ proposal }: { proposal: ProposalRow }) {
  return (
    <Card
      className="pulse-attention"
      style={{ borderLeft: `4px solid ${palette.pending}`, background: palette.bgRaised }}
      styles={{ body: { padding: 24 } }}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="center" size={10} wrap>
          <WarningOutlined style={{ color: palette.pending, fontSize: 18 }} />
          <Title level={4} style={{ margin: 0 }}>
            Idea #{proposal.id} awaiting your decision
          </Title>
          <Tag color="default">{proposal.domain}</Tag>
          {/* How long someone has been sitting on this -- an idea waits for its deep dive until decided. */}
          <Tooltip title={new Date(proposal.created_at).toLocaleString()}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              pending {timeAgo(proposal.created_at)}
            </Text>
          </Tooltip>
        </Space>

        <MarkdownLite text={proposal.description} style={{ maxWidth: 820 }} />

        {/*
          Compact on purpose — this card is where the decision is made. The market read and the
          money path are the two things it turns on; the full blocks (evidence links, assumption,
          launch outline) are one click away in the dialog.
        */}
        <MarketSummary proposal={proposal} />
        <MonetizationSummary proposal={proposal} />

        <Space size={40} wrap>
          <Statistic title="Est. cost to validate" value={proposal.expected_cost} precision={2} prefix="$" />
          <Statistic title="Est. hours to first signal" value={proposal.expected_time_hours} suffix="h" />
          <Statistic
            title="Est. first-year revenue"
            value={proposal.expected_upside}
            precision={2}
            prefix="$"
            valueStyle={{ color: palette.approved }}
          />
        </Space>

        <DecisionControls proposal={proposal} />
      </Space>
    </Card>
  )
}
