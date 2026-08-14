import { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Col, Input, InputNumber, Popconfirm, Row, Space, Switch, Tag, Typography } from 'antd'
import { PauseCircleOutlined, PlayCircleOutlined, StopOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { ControlState } from '../types'
import { api } from '../api'
import { recurrenceLabel } from '../format'
import { palette } from '../theme'

/**
 * Runtime knobs that used to require an env change and a restart. Everything here either
 * reduces what the agent does (pause, abort) or redirects what it researches — none of it can
 * approve a proposal or widen the act-phase fence, which stay with the review flow.
 */
export function ControlPage({ historyVersion }: { historyVersion: number }) {
  const { message } = App.useApp()
  const [control, setControl] = useState<ControlState | null>(null)
  const [domainsText, setDomainsText] = useState('')
  const [directive, setDirective] = useState('')
  const [intervalMinutes, setIntervalMinutes] = useState<number>(60)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    api
      .control()
      .then((state) => {
        setControl(state)
        setDomainsText(state.domains.join('\n'))
        setDirective(state.directive ?? '')
        setIntervalMinutes(Math.round(state.cycleIntervalMs / 60000))
      })
      .catch(() => setControl(null))
  }, [historyVersion])

  async function run(key: string, action: () => Promise<{ control?: ControlState } | unknown>, success: string) {
    setBusy(key)
    try {
      const result = (await action()) as { control?: ControlState }
      if (result?.control) setControl(result.control)
      else setControl(await api.control())
      message.success(success)
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(null)
    }
  }

  if (!control) {
    return <Alert type="warning" message="Control state unavailable — is the agent process running?" />
  }

  const domains = domainsText
    .split('\n')
    .map((d) => d.trim())
    .filter(Boolean)
  const domainsChanged = domains.join('|') !== control.domains.join('|')

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="Research loop">
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Space size={12} align="center" wrap>
                <Switch
                  checked={!control.paused}
                  loading={busy === 'pause'}
                  onChange={(running) => run('pause', () => api.setPaused(!running), running ? 'Loop resumed' : 'Loop paused')}
                />
                <Typography.Text>
                  {control.paused ? (
                    <Tag icon={<PauseCircleOutlined />} color="warning">
                      paused
                    </Tag>
                  ) : (
                    <Tag icon={<PlayCircleOutlined />} color="success">
                      running
                    </Tag>
                  )}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Pausing stops new research cycles. Already-approved work still runs.
                </Typography.Text>
              </Space>

              <Space size={12} wrap>
                <Button
                  icon={<ThunderboltOutlined />}
                  disabled={control.paused}
                  loading={busy === 'run-now'}
                  onClick={() => run('run-now', api.runNow, 'Research cycle starting now')}
                >
                  Run a cycle now
                </Button>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Skips the rest of the wait, currently {recurrenceLabel(control.cycleIntervalMs)}.
                </Typography.Text>
              </Space>

              <Space size={8} wrap align="center">
                <Typography.Text>Cycle interval</Typography.Text>
                <InputNumber
                  min={1}
                  value={intervalMinutes}
                  onChange={(v) => setIntervalMinutes(v ?? 1)}
                  addonAfter="min"
                  style={{ width: 130 }}
                />
                <Button
                  size="small"
                  disabled={intervalMinutes * 60000 === control.cycleIntervalMs}
                  loading={busy === 'interval'}
                  onClick={() => run('interval', () => api.setInterval(intervalMinutes * 60000), 'Interval updated')}
                >
                  Save
                </Button>
              </Space>
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card size="small" title="Execution">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {control.runningProposalId === null ? (
                <Typography.Text type="secondary">Nothing executing right now.</Typography.Text>
              ) : (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Typography.Text>
                    Act phase running for proposal <Tag color="processing">#{control.runningProposalId}</Tag>
                  </Typography.Text>
                  <Popconfirm
                    title="Abort the running act phase?"
                    description="Side effects that already landed stay landed — there is no rollback. Nothing further is attempted, and no outcome or lesson is recorded."
                    okButtonProps={{ danger: true }}
                    onConfirm={() => run('abort', () => api.abort(control.runningProposalId ?? undefined), 'Abort requested')}
                  >
                    <Button danger icon={<StopOutlined />} loading={busy === 'abort'}>
                      Abort
                    </Button>
                  </Popconfirm>
                </Space>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {control.queuedProposalIds.length > 0
                  ? `Queued: ${control.queuedProposalIds.map((id) => `#${id}`).join(', ')}`
                  : 'Nothing queued.'}
              </Typography.Text>
            </Space>
          </Card>
        </Col>
      </Row>

      <Card size="small" title="Domains">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            One per line. Takes effect on the next research cycle; nothing already approved is affected. Saved
            to the database — this overrides AGENT_DOMAINS and survives a restart.
          </Typography.Text>
          <Input.TextArea
            value={domainsText}
            onChange={(e) => setDomainsText(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 8 }}
          />
          <Button
            type="primary"
            disabled={!domainsChanged || domains.length === 0}
            loading={busy === 'domains'}
            onClick={() => run('domains', () => api.setDomains(domains), 'Domains updated')}
          >
            Save domains
          </Button>
        </Space>
      </Card>

      <Card
        size="small"
        title="Directive for the next cycle"
        extra={
          control.directive ? (
            <Tag color={palette.pending} style={{ color: palette.bgSunken }}>
              queued
            </Tag>
          ) : null
        }
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Free-text steer injected into the next research+plan prompt, then cleared — it nudges one cycle rather
            than quietly reshaping every future one. The output is still a proposal you have to approve. A queued
            directive survives a restart; being used clears it.
          </Typography.Text>
          <Input.TextArea
            placeholder="e.g. Focus on ideas that need no paid infrastructure, and prefer extending existing repos over new ones."
            value={directive}
            onChange={(e) => setDirective(e.target.value)}
            autoSize={{ minRows: 2, maxRows: 6 }}
          />
          <Space>
            <Button
              type="primary"
              disabled={directive.trim() === (control.directive ?? '')}
              loading={busy === 'directive'}
              onClick={() => run('directive', () => api.setDirective(directive.trim() || null), 'Directive saved')}
            >
              Save directive
            </Button>
            {control.directive && (
              <Button
                loading={busy === 'clear-directive'}
                onClick={() =>
                  run(
                    'clear-directive',
                    () => {
                      setDirective('')
                      return api.setDirective(null)
                    },
                    'Directive cleared',
                  )
                }
              >
                Clear
              </Button>
            )}
          </Space>
        </Space>
      </Card>
    </Space>
  )
}
