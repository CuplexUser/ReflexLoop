import { Card, Space, Statistic, Tag, Tooltip, Typography } from 'antd'
import { WarningOutlined } from '@ant-design/icons'
import type { ProposalRow } from '../types'
import { palette } from '../theme'
import { timeAgo } from '../format'
import { MarkdownLite } from './MarkdownLite'
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
            Proposal #{proposal.id} awaiting your decision
          </Title>
          <Tag color="default">{proposal.domain}</Tag>
          {/* How long someone has been sitting on this -- a proposal blocks its act phase until decided. */}
          <Tooltip title={new Date(proposal.created_at).toLocaleString()}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              pending {timeAgo(proposal.created_at)}
            </Text>
          </Tooltip>
        </Space>

        <MarkdownLite text={proposal.description} style={{ maxWidth: 820 }} />

        <Space size={40} wrap>
          <Statistic title="Expected cost" value={proposal.expected_cost} precision={2} prefix="$" />
          <Statistic title="Expected time" value={proposal.expected_time_hours} suffix="h" />
          <Statistic
            title="Expected upside"
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
