import { Space, Tag, Typography } from 'antd'
import { PHASE_LABEL } from '../format'
import { palette } from '../theme'

const CONNECTION_LABEL: Record<string, string> = {
  connecting: 'connecting…',
  open: 'live',
  closed: 'disconnected',
}

export function StatusBar({
  connection,
  domains,
  runningPhase,
}: {
  connection: 'connecting' | 'open' | 'closed'
  domains: string[]
  runningPhase: { phase: string; proposalId: number | null } | null
}) {
  const dotColor = connection === 'open' ? palette.approved : connection === 'connecting' ? palette.pending : palette.rejected

  return (
    <Space size={20} align="center">
      <Space size={8} align="center">
        <span
          className={connection === 'open' ? 'status-dot-live' : undefined}
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: dotColor,
          }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          {CONNECTION_LABEL[connection]}
        </Typography.Text>
      </Space>

      {domains.length > 0 && (
        <Typography.Text style={{ fontSize: 13 }} title={domains.join(', ')}>
          lanes: <Typography.Text strong>{domains.length === 1 ? domains[0] : `${domains.length} domains`}</Typography.Text>
        </Typography.Text>
      )}

      {runningPhase ? (
        <Tag color="processing">{PHASE_LABEL[runningPhase.phase] ?? runningPhase.phase} running…</Tag>
      ) : (
        <Tag>idle</Tag>
      )}
    </Space>
  )
}
