import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { PauseCircleOutlined, PlayCircleOutlined, StopOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { ConnectorStatus, ControlState } from '../types'
import { api } from '../api'
import { READ_ONLY_HINT, useConsoleOnly } from '../consoleOnly'
import { recurrenceLabel } from '../format'

/**
 * Runtime knobs that used to require an env change and a restart. Everything here either
 * reduces what the agent does (pause, abort) or redirects what it researches — none of it can
 * approve a proposal or widen the act-phase fence, which stay with the review flow.
 *
 * Under `start:console` this is the only page that still writes, and only in part: domains,
 * cycle interval and the running switch persist for the next real run, while the directive,
 * run-now and abort need a loop that isn't there. Those three are disabled rather than left
 * to fail — run-now especially, which would otherwise report success and wake nothing.
 */
/**
 * Which declarative connectors exist and which are still missing a key. Read-only, and
 * safe in console-only mode: it reports what the process can see, and changing it means
 * editing .env, which is not something the console does.
 *
 * It earns a place here because "why did the act phase say STRIPE_API_KEY is not set" is
 * otherwise only answerable by reading the source. Tools stay catalogued when unconfigured
 * — a proposal can still name one — so the console has to say which are inert.
 */
function ConnectorsCard() {
  const [connectors, setConnectors] = useState<ConnectorStatus[] | null>(null)

  useEffect(() => {
    api.connectors().then(setConnectors).catch(() => setConnectors([]))
  }, [])

  if (!connectors || connectors.length === 0) return null
  const ready = connectors.filter((c) => c.configured).length

  return (
    <Card
      size="small"
      title="Connectors"
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {ready} of {connectors.length} configured
        </Typography.Text>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          REST connectors declared as manifests in <code>src/connectors/defs/</code>. One without a key is
          still catalogued and still nameable in a proposal's fence — it just answers "not set" if called,
          and research isn't told about it. Setting a key takes effect on the next cycle, with no restart.
        </Typography.Text>
        <Space wrap size={8}>
          {connectors.map((c) => (
            <Tooltip
              key={c.id}
              title={
                c.configured
                  ? `${c.operations.length} tools · ${c.operations.filter((o) => o.risk === 'write').length} side-effecting`
                  : `Set ${c.envVar} in .env to enable ${c.operations.length} tools`
              }
            >
              <Tag color={c.configured ? 'success' : 'default'}>
                {c.label}
                {c.configured ? '' : ` · ${c.envVar} unset`}
              </Tag>
            </Tooltip>
          ))}
        </Space>
      </Space>
    </Card>
  )
}

export function ControlPage({ historyVersion }: { historyVersion: number }) {
  const { message } = App.useApp()
  const consoleOnly = useConsoleOnly()
  const navigate = useNavigate()
  const [control, setControl] = useState<ControlState | null>(null)
  const [directive, setDirective] = useState('')
  const [intervalMinutes, setIntervalMinutes] = useState<number>(60)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    api
      .control()
      .then((state) => {
        setControl(state)
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
                <Tooltip title={consoleOnly ? READ_ONLY_HINT : undefined}>
                  <Button
                    icon={<ThunderboltOutlined />}
                    disabled={control.paused || consoleOnly}
                    loading={busy === 'run-now'}
                    onClick={() => run('run-now', api.runNow, 'Research cycle starting now')}
                  >
                    Run a cycle now
                  </Button>
                </Tooltip>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {consoleOnly
                    ? 'No loop is running to wake — start the agent with npm start.'
                    : `Skips the rest of the wait, currently ${recurrenceLabel(control.cycleIntervalMs)}.`}
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
                    disabled={consoleOnly}
                    onConfirm={() => run('abort', () => api.abort(control.runningProposalId ?? undefined), 'Abort requested')}
                  >
                    <Tooltip title={consoleOnly ? READ_ONLY_HINT : undefined}>
                      <Button danger icon={<StopOutlined />} loading={busy === 'abort'} disabled={consoleOnly}>
                        Abort
                      </Button>
                    </Tooltip>
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

      <Card size="small" title="Goals">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            What the agent researches now lives on its own page. The textarea that used to be here made the
            lane's name and its research brief the same string — and that string was also the key everything
            got filed under, so a reworded one silently split the history.
          </Typography.Text>
          <Space wrap>
            {control.goals.filter((g) => g.status === 'active').map((g) => (
              <Tag key={g.id} color="success">
                {g.title}
              </Tag>
            ))}
            {control.goals.some((g) => g.status === 'suggested') && (
              <Tag color="warning">
                {control.goals.filter((g) => g.status === 'suggested').length} awaiting your decision
              </Tag>
            )}
          </Space>
          <Button type="primary" onClick={() => navigate('/goals')}>
            Manage goals
          </Button>
        </Space>
      </Card>

      <ConnectorsCard />

      <Card
        size="small"
        title="Directive for the next cycle"
        extra={
          control.directive ? (
            <Tag color="warning">queued</Tag>
          ) : null
        }
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Free-text steer injected into the next research+plan prompt, then cleared — it nudges one cycle rather
            than quietly reshaping every future one. The output is still a proposal you have to approve. A queued
            directive survives a restart; being used clears it.
          </Typography.Text>
          {consoleOnly && (
            <Alert
              type="info"
              showIcon
              message="Not settable from the read-only console — a directive steers a research cycle, and this mode runs none."
            />
          )}
          <Input.TextArea
            placeholder="e.g. Focus on ideas that need no paid infrastructure, and prefer extending existing repos over new ones."
            value={directive}
            onChange={(e) => setDirective(e.target.value)}
            disabled={consoleOnly}
            autoSize={{ minRows: 2, maxRows: 6 }}
          />
          <Space>
            <Button
              type="primary"
              disabled={consoleOnly || directive.trim() === (control.directive ?? '')}
              loading={busy === 'directive'}
              onClick={() => run('directive', () => api.setDirective(directive.trim() || null), 'Directive saved')}
            >
              Save directive
            </Button>
            {control.directive && (
              <Button
                disabled={consoleOnly}
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
