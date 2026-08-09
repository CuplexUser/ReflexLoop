import { useState } from 'react'
import { App, Button, Card, Input, Space, Statistic, Tag, Typography } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, WarningOutlined } from '@ant-design/icons'
import type { ProposalRow } from '../types'
import { api } from '../api'
import { palette } from '../theme'

const { Title, Paragraph, Text } = Typography

export function ProposalReviewCard({ proposal }: { proposal: ProposalRow }) {
  const { message } = App.useApp()
  const [rejecting, setRejecting] = useState(false)
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null)

  async function decide(approved: boolean) {
    setSubmitting(approved ? 'approve' : 'reject')
    try {
      await api.decide(proposal.id, approved, notes || undefined)
      message.success(approved ? `Approved proposal #${proposal.id}` : `Rejected proposal #${proposal.id}`)
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Decision failed')
    } finally {
      setSubmitting(null)
    }
  }

  const tools = proposal.required_tools
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  return (
    <Card
      className="pulse-attention"
      style={{ borderLeft: `4px solid ${palette.pending}`, background: '#1B1F27' }}
      styles={{ body: { padding: 24 } }}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="center" size={10}>
          <WarningOutlined style={{ color: palette.pending, fontSize: 18 }} />
          <Title level={4} style={{ margin: 0 }}>
            Proposal #{proposal.id} awaiting your decision
          </Title>
          <Tag color="default">{proposal.domain}</Tag>
        </Space>

        <Paragraph style={{ marginBottom: 0, maxWidth: 820 }}>{proposal.description}</Paragraph>

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

        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            TOOLS REQUIRED
          </Text>
          <div style={{ marginTop: 4 }}>
            {tools.map((t) => (
              <Tag key={t} className="mono">
                {t}
              </Tag>
            ))}
          </div>
        </div>

        {rejecting && (
          <Input.TextArea
            placeholder="Reason (optional) — saved with the rejection for future reference"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
        )}

        <Space>
          <Button
            type="primary"
            icon={<CheckCircleOutlined />}
            loading={submitting === 'approve'}
            disabled={submitting !== null}
            style={{ background: palette.approved, borderColor: palette.approved }}
            onClick={() => decide(true)}
          >
            Approve
          </Button>
          {rejecting ? (
            <Button
              danger
              icon={<CloseCircleOutlined />}
              loading={submitting === 'reject'}
              disabled={submitting !== null}
              onClick={() => decide(false)}
            >
              Confirm reject
            </Button>
          ) : (
            <Button
              danger
              ghost
              icon={<CloseCircleOutlined />}
              disabled={submitting !== null}
              onClick={() => setRejecting(true)}
            >
              Reject
            </Button>
          )}
        </Space>
      </Space>
    </Card>
  )
}
