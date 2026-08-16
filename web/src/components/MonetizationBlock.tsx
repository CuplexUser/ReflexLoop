import { Descriptions, Space, Tag, Tooltip, Typography } from 'antd'
import { RobotOutlined, UserOutlined } from '@ant-design/icons'
import type { ProposalRow } from '../types'
import { parseMonetization, parseSteps, revenueModelLabel } from '../monetization'
import { palette } from '../theme'

/**
 * How a proposal is supposed to make money, and what stands between approval and the first
 * dollar. This is the block the review decision actually turns on — before it existed the
 * only structured money field was a single `expected_upside` number, and everything else
 * (the mechanism, the buyer, the price, the steps) was prose buried in the description, if
 * it was stated at all.
 *
 * Everything renders from structured fields rather than Markdown, so MarkdownLite's
 * bold-and-bullets-only limit doesn't apply here. Proposals written before these columns
 * existed have nulls and render nothing — an absent section rather than a row of dashes.
 */

function shortTool(name: string) {
  return name.replace(/^mcp__(memory|integrations)__/, '')
}

/**
 * The one-line version, for the Dashboard card where the decision is actually made. Two lines
 * at most: the mechanism and the price, then how many steps and how many of them need a person.
 */
export function MonetizationSummary({ proposal }: { proposal: ProposalRow }) {
  const monetization = parseMonetization(proposal)
  const steps = parseSteps(proposal)
  const model = revenueModelLabel(proposal.revenue_model)
  if (!monetization && steps.length === 0) return null

  const humanSteps = steps.filter((s) => s.owner === 'human').length

  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      <Space size={8} wrap>
        {model && <Tag color="green">{model}</Tag>}
        {monetization && (
          <Typography.Text style={{ fontSize: 13 }}>
            {monetization.whoPays} pays <Typography.Text strong>{monetization.pricePoint}</Typography.Text> ·
            first dollar in ~{monetization.daysToFirstDollar}d via {monetization.pathToFirstDollar}
          </Typography.Text>
        )}
      </Space>
      {steps.length > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {steps.length} step{steps.length === 1 ? '' : 's'}
          {humanSteps > 0 && `, ${humanSteps} needing you`}
        </Typography.Text>
      )}
    </Space>
  )
}

/** The full block, for the proposal dialog. */
export function MonetizationBlock({ proposal }: { proposal: ProposalRow }) {
  const monetization = parseMonetization(proposal)
  const steps = parseSteps(proposal)
  const model = revenueModelLabel(proposal.revenue_model)
  if (!monetization && steps.length === 0) return null

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space align="center" size={8}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          HOW THIS MAKES MONEY
        </Typography.Text>
        {model && <Tag color="green">{model}</Tag>}
      </Space>

      {monetization && (
        <Descriptions size="small" column={1} bordered items={[
          { key: 'who', label: 'Who pays', children: monetization.whoPays },
          { key: 'price', label: 'Price point', children: monetization.pricePoint },
          { key: 'path', label: 'Path to first dollar', children: monetization.pathToFirstDollar },
          {
            key: 'days',
            label: 'Time to first dollar',
            children: `${monetization.daysToFirstDollar} days from approval`,
          },
          {
            key: 'assumption',
            label: 'Key assumption',
            // The thing most worth disagreeing with, so it's the one field that gets emphasis.
            children: <Typography.Text strong>{monetization.keyAssumption}</Typography.Text>,
          },
          { key: 'signal', label: 'Validation signal', children: monetization.validationSignal },
        ]} />
      )}

      {steps.length > 0 && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            PLAN — {steps.filter((s) => s.owner === 'human').length} step
            {steps.filter((s) => s.owner === 'human').length === 1 ? '' : 's'} need you
          </Typography.Text>
          <ol style={{ margin: '6px 0 0', paddingLeft: 22 }}>
            {steps.map((step, i) => (
              <li key={`${i}-${step.title}`} style={{ marginBottom: 6 }}>
                <Space size={6} wrap>
                  <Tooltip
                    title={
                      step.owner === 'agent'
                        ? 'The act phase does this'
                        : 'Only you can do this — the agent has no tool for it'
                    }
                  >
                    <Tag
                      icon={step.owner === 'agent' ? <RobotOutlined /> : <UserOutlined />}
                      color={step.owner === 'agent' ? 'default' : 'warning'}
                    >
                      {step.owner}
                    </Tag>
                  </Tooltip>
                  <span>{step.title}</span>
                  {step.tool && (
                    <Tag className="mono" color="default">
                      {shortTool(step.tool)}
                    </Tag>
                  )}
                </Space>
                <div style={{ fontSize: 12, color: palette.textMuted, marginTop: 2 }}>
                  done when: {step.doneWhen}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Space>
  )
}
