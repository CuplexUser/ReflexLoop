import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { CheckOutlined, CloseOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import type { GoalHealth, GoalRow, GoalStatus } from '../types'
import { api } from '../api'
import { READ_ONLY_HINT, useConsoleOnly } from '../consoleOnly'
import { palette } from '../theme'
import { MarkdownLite } from '../components/MarkdownLite'

/**
 * What the agent is pointed at.
 *
 * Replaces the newline-delimited textarea that used to live on Agent control. That field was
 * doing two jobs at once — naming a lane and briefing it — so operators ended up writing whole
 * paragraphs of research instructions into what was also the grouping key for proposals,
 * lessons and the Economics scoreboard. Title and brief are separate here, and the brief is
 * what reaches the research prompt verbatim.
 *
 * The Suggested section is the other half: `goal_suggest` lets the agent point at an adjacent
 * lane when one it was given keeps coming up empty, but a suggested goal is inert — never
 * researched, never in a prompt — until someone accepts it here. Same shape as proposal
 * approval, one level up: the agent proposes a direction, the operator decides.
 */
export function GoalsPage() {
  const { message } = App.useApp()
  const consoleOnly = useConsoleOnly()
  const navigate = useNavigate()
  const { id } = useParams()

  const [goals, setGoals] = useState<GoalRow[]>([])
  const [health, setHealth] = useState<GoalHealth[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<number | 'new' | null>(null)
  const [draft, setDraft] = useState<{ title: string; brief: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.goals()
      setGoals(data.goals)
      setHealth(data.health)
    } catch {
      setGoals([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const healthById = useMemo(() => new Map(health.map((h) => [h.goal_id, h])), [health])
  const suggested = goals.filter((g) => g.status === 'suggested')
  const live = goals.filter((g) => g.status === 'active' || g.status === 'paused')
  const retired = goals.filter((g) => g.status === 'retired')

  // The deep-linked goal, so /goals/:id opens its editor and Back closes it — same convention
  // as every other detail view in the console.
  const editing = id ? (goals.find((g) => g.id === Number(id)) ?? null) : null

  async function act(key: number | 'new', action: () => Promise<unknown>, success: string) {
    setBusy(key)
    try {
      await action()
      await load()
      message.success(success)
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="Goals are what each research cycle works from."
        description="The brief is passed to the research prompt word for word — put the specifics there (markets, audiences, incumbents to check first, what to avoid), and keep the title short, since it's also how work gets grouped on the Economics scoreboard. Changes take effect on the next cycle; nothing already approved is affected."
      />

      {suggested.length > 0 && (
        <Card
          size="small"
          title={
            <Space>
              <Badge count={suggested.length} color={palette.pending} />
              <span>Suggested by the agent</span>
            </Space>
          }
        >
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Not being researched. A suggestion never changes what the agent works on until you accept it —
              dismissing one retires it, which also stops the same lane being suggested again.
            </Typography.Text>
            {suggested.map((goal) => (
              <Card key={goal.id} size="small" type="inner" title={goal.title}>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {goal.rationale && (
                    <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 13 }}>
                      <strong>Why:</strong> {goal.rationale}
                    </Typography.Paragraph>
                  )}
                  <MarkdownLite text={goal.brief} />
                  <Space wrap>
                    <Tooltip title={consoleOnly ? undefined : 'Makes this a lane the next cycle researches'}>
                      <Button
                        type="primary"
                        icon={<CheckOutlined />}
                        loading={busy === goal.id}
                        onClick={() => act(goal.id, () => api.acceptGoal(goal.id), `Accepted "${goal.title}"`)}
                      >
                        Accept
                      </Button>
                    </Tooltip>
                    <Button icon={<EditOutlined />} onClick={() => navigate(`/goals/${goal.id}`)}>
                      Edit first
                    </Button>
                    <Button
                      icon={<CloseOutlined />}
                      loading={busy === goal.id}
                      onClick={() => act(goal.id, () => api.dismissGoal(goal.id), 'Dismissed')}
                    >
                      Dismiss
                    </Button>
                  </Space>
                </Space>
              </Card>
            ))}
          </Space>
        </Card>
      )}

      <Card
        size="small"
        title="Goals"
        extra={
          <Tooltip title={consoleOnly ? READ_ONLY_HINT : undefined}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setDraft({ title: '', brief: '' })}
              disabled={consoleOnly}
            >
              New goal
            </Button>
          </Tooltip>
        }
      >
        {live.length === 0 && !loading ? (
          <Empty description="No goals yet — the agent has nothing to research." />
        ) : (
          <Row gutter={[16, 16]}>
            {live.map((goal) => {
              const h = healthById.get(goal.id)
              return (
                <Col xs={24} xl={12} key={goal.id}>
                  <Card
                    size="small"
                    title={
                      <Space size={8} wrap>
                        <span>{goal.title}</span>
                        <StatusTag status={goal.status} />
                        {goal.origin === 'agent' && <Tag>agent-suggested</Tag>}
                      </Space>
                    }
                    extra={
                      <Space size={4}>
                        <Button size="small" icon={<EditOutlined />} onClick={() => navigate(`/goals/${goal.id}`)} />
                        <Tooltip title={consoleOnly ? READ_ONLY_HINT : 'Stop researching this without deleting its history'}>
                          <Button
                            size="small"
                            disabled={consoleOnly}
                            loading={busy === goal.id}
                            onClick={() =>
                              act(
                                goal.id,
                                () => api.updateGoal(goal.id, { status: goal.status === 'active' ? 'paused' : 'active' }),
                                goal.status === 'active' ? 'Paused' : 'Resumed',
                              )
                            }
                          >
                            {goal.status === 'active' ? 'Pause' : 'Resume'}
                          </Button>
                        </Tooltip>
                      </Space>
                    }
                  >
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <div style={{ maxHeight: 120, overflow: 'auto' }}>
                        <MarkdownLite text={goal.brief || '_No brief — the title alone is all the research prompt gets._'} />
                      </div>
                      {h && <GoalHealthRow health={h} />}
                    </Space>
                  </Card>
                </Col>
              )
            })}
          </Row>
        )}
      </Card>

      {retired.length > 0 && (
        <Card size="small" title={`Retired (${retired.length})`}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Not researched, and kept rather than deleted for two reasons: the work filed under them stays
              attributed on the scoreboard, and the agent is refused if it suggests one of these again.
            </Typography.Text>
            <Space wrap>
              {retired.map((goal) => (
                <Tag key={goal.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/goals/${goal.id}`)}>
                  {goal.title}
                </Tag>
              ))}
            </Space>
          </Space>
        </Card>
      )}

      <GoalEditor
        goal={editing}
        draft={draft}
        consoleOnly={consoleOnly}
        onClose={() => {
          setDraft(null)
          if (editing) navigate('/goals')
        }}
        onSave={async (fields) => {
          if (editing) {
            await act(editing.id, () => api.updateGoal(editing.id, fields), 'Goal updated')
            navigate('/goals')
          } else {
            await act('new', () => api.createGoal(fields), 'Goal created')
            setDraft(null)
          }
        }}
        onDelete={
          editing
            ? async () => {
                await act(editing.id, () => api.deleteGoal(editing.id), 'Goal deleted')
                navigate('/goals')
              }
            : undefined
        }
      />
    </Space>
  )
}

function StatusTag({ status }: { status: GoalStatus }) {
  const color =
    status === 'active' ? palette.approved : status === 'paused' ? palette.pending : status === 'suggested' ? palette.pending : undefined
  return <Tag color={color}>{status}</Tag>
}

/**
 * The numbers that answer "is this lane still worth researching?" — previously invisible, which
 * made a goal that had gone quiet look exactly like one nobody had gotten to yet.
 */
function GoalHealthRow({ health }: { health: GoalHealth }) {
  const stale = health.empty_cycles >= 3
  return (
    <Space size={24} wrap>
      <Statistic title="Proposals" value={health.proposals} valueStyle={{ fontSize: 18 }} />
      <Statistic title="Approved" value={health.approved} valueStyle={{ fontSize: 18 }} />
      <Statistic title="Shipped" value={health.shipped} valueStyle={{ fontSize: 18 }} />
      <Statistic
        title="Model spend"
        value={health.api_spend}
        precision={2}
        prefix="$"
        valueStyle={{ fontSize: 18 }}
      />
      <Tooltip title="Research cycles since this goal last produced a proposal. Past three, the research prompt starts asking for an adjacent angle or a goal_suggest instead of more of the same.">
        <Statistic
          title="Empty cycles"
          value={health.empty_cycles}
          valueStyle={{ fontSize: 18, color: stale ? palette.rejected : undefined }}
        />
      </Tooltip>
    </Space>
  )
}

function GoalEditor({
  goal,
  draft,
  consoleOnly,
  onClose,
  onSave,
  onDelete,
}: {
  goal: GoalRow | null
  draft: { title: string; brief: string } | null
  consoleOnly: boolean
  onClose: () => void
  onSave: (fields: { title: string; brief: string; weight?: number; status?: GoalStatus }) => Promise<void>
  onDelete?: () => Promise<void>
}) {
  const open = Boolean(goal || draft)
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [weight, setWeight] = useState(1)

  useEffect(() => {
    setTitle(goal?.title ?? draft?.title ?? '')
    setBrief(goal?.brief ?? draft?.brief ?? '')
    setWeight(goal?.weight ?? 1)
  }, [goal, draft])

  const isSuggestion = goal?.status === 'suggested'

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={goal ? `Goal #${goal.id}` : 'New goal'}
      width={720}
      footer={
        <Space>
          {onDelete && (
            <Popconfirm
              title="Delete this goal?"
              description="Proposals, lessons and notes filed under it are kept — they just stop being attributed to a goal. Retiring is usually the better move: it keeps the attribution and stops the agent re-suggesting the lane."
              okButtonProps={{ danger: true }}
              disabled={consoleOnly}
              onConfirm={onDelete}
            >
              <Tooltip title={consoleOnly ? 'Deleting reaches other tables, so it needs a normal run.' : undefined}>
                <Button danger icon={<DeleteOutlined />} disabled={consoleOnly}>
                  Delete
                </Button>
              </Tooltip>
            </Popconfirm>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="primary"
            disabled={!title.trim() || consoleOnly}
            onClick={() => void onSave({ title: title.trim(), brief, weight, ...(isSuggestion ? { status: 'active' as const } : {}) })}
          >
            {isSuggestion ? 'Save and accept' : 'Save'}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {isSuggestion && (
          <Alert
            type="info"
            showIcon
            message="This is an agent suggestion — saving here accepts it and makes it active."
            description={goal?.rationale ?? undefined}
          />
        )}
        <div>
          <Typography.Text strong>Title</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
            Short and stable. This is the grouping key on the Economics scoreboard, and what the agent is told to
            echo back verbatim when it files a proposal or a lesson — so renaming it splits the history.
          </Typography.Paragraph>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>Brief</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
            Passed to the research prompt word for word. Markdown is fine. Be specific about what counts and what
            doesn't — which markets, which buyers, which incumbents to rule out first.
          </Typography.Paragraph>
          <Input.TextArea value={brief} onChange={(e) => setBrief(e.target.value)} autoSize={{ minRows: 5, maxRows: 16 }} />
        </div>
        <Space align="center">
          <Typography.Text strong>Weight</Typography.Text>
          <InputNumber min={0} step={0.5} value={weight} onChange={(v) => setWeight(v ?? 1)} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Ordering only, for now — the research prompt lists goals in weight order and picks whichever look most
            promising.
          </Typography.Text>
        </Space>
      </Space>
    </Modal>
  )
}
