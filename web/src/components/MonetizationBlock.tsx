import { Descriptions, Space, Tag, Tooltip, Typography } from 'antd'
import { RobotOutlined, UserOutlined } from '@ant-design/icons'
import type { ProposalRow } from '../types'
import { parseMonetization, parseSteps, revenueModelLabel } from '../monetization'
import { palette } from '../theme'

/**
 * How an idea is supposed to make money, and the launch outline a human would follow to the
 * first revenue. Together with the market block, this is what the review decision turns on.
 *
 * Everything renders from structured fields rather than Markdown. Proposals written before
 * these columns existed have nulls and render nothing — an absent section rather than a row of
 * dashes. Legacy build-mode steps carry an agent/human owner and a tool; a research-mode
 * launch outline is all the human's and has neither.
 */

function shortTool(name: string) {
  return name.replace(/^mcp__(memory|integrations)__/, '')
}

/**
 * The one-line version, for the Dashboard card where the decision is actually made. Two lines
 * at most: the mechanism and the price, then how long the launch outline is.
 */
export function MonetizationSummary({ proposal }: { proposal: ProposalRow }) {
  const monetization = parseMonetization(proposal)
  const steps = parseSteps(proposal)
  const model = revenueModelLabel(proposal.revenue_model)
  if (!monetization && steps.length === 0) return null

  const legacy = steps.some((s) => s.owner)
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
          {steps.length}-step {legacy ? 'plan' : 'launch outline'}
          {legacy && humanSteps > 0 && `, ${humanSteps} needing you`}
        </Typography.Text>
      )}
    </Space>
  )
}

/** The full block, for the idea dialog. */
export function MonetizationBlock({ proposal }: { proposal: ProposalRow }) {
  const monetization = parseMonetization(proposal)
  const steps = parseSteps(proposal)
  const legacy = steps.some((s) => s.owner)
  const humanSteps = steps.filter((s) => s.owner === 'human').length
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
            children: `~${monetization.daysToFirstDollar} days from starting`,
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
            {legacy
              ? `PLAN (legacy build mode) — ${humanSteps} step${humanSteps === 1 ? '' : 's'} needed a human`
              : 'LAUNCH OUTLINE — what a human would do, in order'}
          </Typography.Text>
          <ol style={{ margin: '6px 0 0', paddingLeft: 22 }}>
            {steps.map((step, i) => (
              <li key={`${i}-${step.title}`} style={{ marginBottom: 6 }}>
                <Space size={6} wrap>
                  {step.owner && (
                    <Tooltip
                      title={step.owner === 'agent' ? 'The build-mode act phase did this' : 'A step for a human'}
                    >
                      <Tag
                        icon={step.owner === 'agent' ? <RobotOutlined /> : <UserOutlined />}
                        color={step.owner === 'agent' ? 'default' : 'warning'}
                      >
                        {step.owner}
                      </Tag>
                    </Tooltip>
                  )}
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
