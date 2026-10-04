import { Descriptions, Space, Tag, Typography } from 'antd'
import type { ProposalRow } from '../types'
import { parseMarket } from '../monetization'
import { CONFIDENCE_TAG, scoreTag } from '../report'

/**
 * The research phase's read on an idea's market: demand evidence with its sources, named
 * competitors, a size estimate, the key risks and a viability score. These are claims the deep
 * dive is told to check, so every evidence line links to where it came from.
 *
 * A legacy build-mode proposal has no market block and renders nothing.
 */

/** One line, for the Dashboard review card and table cells. */
export function MarketSummary({ proposal }: { proposal: ProposalRow }) {
  const market = parseMarket(proposal)
  if (!market) return null
  return (
    <Space size={6} wrap>
      <Tag color={scoreTag(market.viabilityScore)}>viability {market.viabilityScore}/5</Tag>
      <Tag color={CONFIDENCE_TAG[market.confidence]}>{market.confidence} confidence</Tag>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {market.competitors.length} competitor{market.competitors.length === 1 ? '' : 's'} named ·{' '}
        {market.demandEvidence.length} demand signal{market.demandEvidence.length === 1 ? '' : 's'}
      </Typography.Text>
    </Space>
  )
}

/** The full block, for the idea dialog. */
export function MarketBlock({ proposal }: { proposal: ProposalRow }) {
  const market = parseMarket(proposal)
  if (!market) return null

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space align="center" size={8} wrap>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          THE MARKET, AS RESEARCH READ IT
        </Typography.Text>
        <Tag color={scoreTag(market.viabilityScore)}>viability {market.viabilityScore}/5</Tag>
        <Tag color={CONFIDENCE_TAG[market.confidence]}>{market.confidence} confidence</Tag>
      </Space>

      <Descriptions
        size="small"
        column={1}
        bordered
        items={[
          { key: 'size', label: 'Market size', children: market.marketSize },
          {
            key: 'demand',
            label: 'Demand evidence',
            children: (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {market.demandEvidence.map((d, i) => (
                  <li key={i}>
                    {d.claim}{' '}
                    <Typography.Link href={d.sourceUrl} target="_blank" rel="noopener noreferrer">
                      source
                    </Typography.Link>
                  </li>
                ))}
              </ul>
            ),
          },
          {
            key: 'competitors',
            label: 'Competitors',
            children:
              market.competitors.length === 0 ? (
                <Typography.Text type="secondary">None found</Typography.Text>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {market.competitors.map((c, i) => (
                    <li key={i}>
                      {c.url ? (
                        <Typography.Link href={c.url} target="_blank" rel="noopener noreferrer">
                          {c.name}
                        </Typography.Link>
                      ) : (
                        c.name
                      )}
                      {c.pricing && <Typography.Text type="secondary"> · {c.pricing}</Typography.Text>}
                      {c.gap && <div style={{ fontSize: 12 }}>Gap: {c.gap}</div>}
                    </li>
                  ))}
                </ul>
              ),
          },
          {
            key: 'risks',
            label: 'Key risks',
            children: (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {market.keyRisks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ),
          },
        ]}
      />
    </Space>
  )
}
