import { useEffect, useState } from 'react'
import { Button, Space, Tag, Tooltip, Typography } from 'antd'
import { BellFilled, BellOutlined } from '@ant-design/icons'
import { PHASE_LABEL } from '../format'
import { palette } from '../theme'
import { getPermissionState, requestPermission, type NotificationPermissionState } from '../notifications'

const CONNECTION_LABEL: Record<string, string> = {
  connecting: 'connecting…',
  open: 'live',
  closed: 'disconnected',
}

function NotificationBell() {
  const [state, setState] = useState<NotificationPermissionState>('default')

  useEffect(() => {
    setState(getPermissionState())
  }, [])

  if (state === 'unsupported') return null

  if (state === 'granted') {
    return (
      <Tooltip title="Browser notifications enabled -- you'll be notified here when a proposal needs review or a scheduled action starts">
        <BellFilled style={{ color: palette.approved, fontSize: 16 }} />
      </Tooltip>
    )
  }

  if (state === 'denied') {
    return (
      <Tooltip title="Browser notifications are blocked -- enable them in your browser's site settings to turn this back on">
        <BellOutlined style={{ color: palette.textFaint, fontSize: 16 }} />
      </Tooltip>
    )
  }

  return (
    <Tooltip title="Get a browser notification here when a proposal needs review or a scheduled action starts">
      <Button size="small" icon={<BellOutlined />} onClick={async () => setState(await requestPermission())}>
        Enable notifications
      </Button>
    </Tooltip>
  )
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

      <NotificationBell />
    </Space>
  )
}
