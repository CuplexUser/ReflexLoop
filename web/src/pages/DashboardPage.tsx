import { Button, Space, Typography } from 'antd'
import type { FeedEntry, OutcomeRow, ProposalRow } from '../types'
import { ProposalReviewCard } from '../components/ProposalReviewCard'
import { StatTiles } from '../components/StatTiles'
import { LiveConsole } from '../components/LiveConsole'

export function DashboardPage({
  pendingProposals,
  proposals,
  outcomes,
  totalCostUsd,
  feed,
  onOpenLiveFeed,
}: {
  pendingProposals: ProposalRow[]
  proposals: ProposalRow[]
  outcomes: OutcomeRow[]
  totalCostUsd: number
  feed: FeedEntry[]
  onOpenLiveFeed: () => void
}) {
  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      {pendingProposals.length > 0 && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {pendingProposals.map((p) => (
            <ProposalReviewCard key={p.id} proposal={p} />
          ))}
        </Space>
      )}

      <StatTiles proposals={proposals} outcomes={outcomes} totalCostUsd={totalCostUsd} />

      <div>
        <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Recent activity
          </Typography.Title>
          <Button type="link" onClick={onOpenLiveFeed} style={{ padding: 0 }}>
            Open full live feed →
          </Button>
        </Space>
        <LiveConsole feed={feed.slice(-40)} height={280} />
      </div>
    </Space>
  )
}
