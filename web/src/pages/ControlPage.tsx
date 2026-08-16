import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
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
import { ToolTag } from '../components/ToolFence'
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
 * Which declarative connectors exist, what each one actually lets the agent do, and which
 * are still missing a key. Read-only, and safe in console-only mode: it reports what the
 * process can see, and changing it means editing .env, which is not something the console does.
 *
 * The operation list is the point. The endpoint has always returned each tool's name, risk
 * and description — the card used to render that as a count in a tooltip, which says a
 * connector *exists* without ever saying what it does, and left the manifests as the only
 * real answer. Descriptions are written for the model but read fine to a person, so they're
 * shown verbatim rather than re-worded into a second thing to keep in sync.
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
          External services the agent can call — payments, email, analytics, DNS — each declared as a
          manifest in <code>src/connectors/defs/</code>. Expand one to see the tools it grants. Read-only
          tools the research phase may call freely; side-effecting ones still run only inside an act phase,
          and only when a proposal <em>you approved</em> named that exact tool.
        </Typography.Text>
        <Collapse
          ghost
          size="small"
          items={connectors.map((c) => {
            const writes = c.operations.filter((o) => o.risk === 'write').length
            return {
              key: c.id,
              label: (
                <Space size={8} wrap>
                  <Typography.Text strong>{c.label}</Typography.Text>
                  {c.configured ? (
                    <Tag color="success">key set</Tag>
                  ) : (
                    <Tag className="mono">{c.envVar ? `${c.envVar} unset` : 'no key set'}</Tag>
                  )}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {c.operations.length} tool{c.operations.length === 1 ? '' : 's'}
                    {writes > 0 ? ` · ${writes} side-effecting` : ''}
                  </Typography.Text>
                </Space>
              ),
              extra: c.docsUrl ? (
                // Inside a Collapse header, so the click must not also toggle the panel.
                <Typography.Link
                  href={c.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 12 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  API docs ↗
                </Typography.Link>
              ) : undefined,
              children: (
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  {!c.configured && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Set <code>{c.envVar}</code> in <code>.env</code> to enable these. Connector credentials are
                      read per call, so a key filled in while the loop runs takes effect on the next cycle with no
                      restart. Until then each tool answers "not set" when called, and the research phase isn't
                      told it exists — though a proposal can still name it in its fence.
                    </Typography.Text>
                  )}
                  {c.operations.map((op) => (
                    <div key={op.toolName}>
                      <ToolTag name={op.toolName} risk={op.risk} />
                      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '2px 0 0' }}>
                        {op.description}
                      </Typography.Paragraph>
                    </div>
                  ))}
                </Space>
              ),
            }
          })}
        />
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
