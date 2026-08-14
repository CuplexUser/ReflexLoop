import { useState } from 'react'
import { Button, Card, Input, Space, Typography } from 'antd'
import { LockOutlined } from '@ant-design/icons'
import { setToken } from '../auth'
import { palette } from '../theme'

/**
 * Shown when the backend has AGENT_API_TOKEN set and the console doesn't have a matching one.
 * A single shared secret for the whole console — enough to stop another device on the network
 * reaching the decision endpoint, not a user identity system.
 */
export function TokenGate({ onSubmit }: { onSubmit: () => void }) {
  const [value, setValue] = useState('')

  function submit() {
    if (!value.trim()) return
    setToken(value.trim())
    onSubmit()
  }

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', background: palette.bgBase }}>
      <Card style={{ width: 420 }}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space align="center" size={10}>
            <LockOutlined style={{ color: palette.pending, fontSize: 18 }} />
            <Typography.Title level={5} style={{ margin: 0 }}>
              API token required
            </Typography.Title>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            This console is protected by the shared token in <span className="mono">AGENT_API_TOKEN</span>.
          </Typography.Text>
          <Input.Password
            autoFocus
            placeholder="Paste the token"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onPressEnter={submit}
          />
          <Button type="primary" block disabled={!value.trim()} onClick={submit}>
            Unlock
          </Button>
        </Space>
      </Card>
    </div>
  )
}
