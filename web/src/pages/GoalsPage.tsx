import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Alert,
  App,
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
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  PlusOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import type { GoalHealth, GoalRow, GoalStatus } from '../types'
import { api } from '../api'
import { READ_ONLY_HINT, useConsoleOnly } from '../consoleOnly'
import { palette } from '../theme'
import { money, timeAgo } from '../format'
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
 *
 * Layout notes, since they encode decisions that looked like taste and weren't:
 *  - Tags take AntD *preset* names, never `palette.*`. The palette resolves to `var(--rl-*)`,
 *    and AntD derives a tag's background and text from the color with color math that a
 *    `var()` string breaks — which rendered as a near-white chip with unreadable text.
 *  - Cards in a row are stretched to equal height and the metrics are pinned to the bottom
 *    (`marginTop: auto`), so the numbers line up across a row instead of floating wherever
 *    each brief happens to end.
 *  - A long brief is clamped with a fade and a Show more toggle rather than an inner
 *    scrollbar, which truncated mid-word and hid the rest behind a scroll nobody would find.
 */

/** Goals a cycle can actually pick up, ordered the way the research prompt sees them. */
function orderLive(goals: GoalRow[]): GoalRow[] {
  return [...goals].sort(
    (a, b) =>
      Number(b.status === 'active') - Number(a.status === 'active') ||
      b.weight - a.weight ||
      a.title.localeCompare(b.title),
  )
}

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
  const live = useMemo(() => orderLive(goals.filter((g) => g.status === 'active' || g.status === 'paused')), [goals])
  const retired = goals.filter((g) => g.status === 'retired')
  const activeCount = live.filter((g) => g.status === 'active').length

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
      {suggested.length > 0 && (
        <Card
          size="small"
          title={
            <Space size={8}>
              <span>Suggested by the agent</span>
              <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                {suggested.length}
              </Tag>
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
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  {goal.rationale && (
                    <Alert
                      type="info"
                      message={
                        <span style={{ fontSize: 13 }}>
                          <strong>Why the agent asked:</strong> {goal.rationale}
                        </span>
                      }
                    />
                  )}
                  <MarkdownLite text={goal.brief} style={{ fontSize: 13 }} />
                  <Space wrap>
                    <Tooltip title={consoleOnly ? READ_ONLY_HINT : 'Makes this a lane the next cycle researches'}>
                      <Button
                        type="primary"
                        icon={<CheckOutlined />}
                        disabled={consoleOnly}
                        loading={busy === goal.id}
                        onClick={() => act(goal.id, () => api.acceptGoal(goal.id), `Accepted "${goal.title}"`)}
                      >
                        Accept
                      </Button>
                    </Tooltip>
                    <Button icon={<EditOutlined />} onClick={() => navigate(`/goals/${goal.id}`)}>
                      Edit first
                    </Button>
                    <Tooltip title={consoleOnly ? READ_ONLY_HINT : 'Retires the lane, and refuses it if re-suggested'}>
                      <Button
                        icon={<CloseOutlined />}
                        disabled={consoleOnly}
                        loading={busy === goal.id}
                        onClick={() => act(goal.id, () => api.dismissGoal(goal.id), 'Dismissed')}
                      >
                        Dismiss
                      </Button>
                    </Tooltip>
                  </Space>
                </Space>
              </Card>
            ))}
          </Space>
        </Card>
      )}

      <Card
        size="small"
        title={
          <Space size={8}>
            <span>Goals</span>
            {live.length > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                {activeCount} active
                {live.length > activeCount ? `, ${live.length - activeCount} paused` : ''}
              </Typography.Text>
            )}
          </Space>
        }
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
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Each research cycle works from these. The brief reaches the research prompt word for word; the title is
            the grouping key on the Economics scoreboard. Changes take effect next cycle — nothing already approved
            is affected.
          </Typography.Text>

          {live.length === 0 && !loading ? (
            <Empty description="No goals yet — the agent has nothing to research." />
          ) : (
            <Row gutter={[16, 16]} align="stretch">
              {live.map((goal) => (
                <Col xs={24} xl={12} key={goal.id}>
                  <GoalCard
                    goal={goal}
                    health={healthById.get(goal.id)}
                    consoleOnly={consoleOnly}
                    busy={busy === goal.id}
                    onEdit={() => navigate(`/goals/${goal.id}`)}
                    onToggleStatus={() =>
                      act(
                        goal.id,
                        () => api.updateGoal(goal.id, { status: goal.status === 'active' ? 'paused' : 'active' }),
                        goal.status === 'active' ? 'Paused' : 'Resumed',
                      )
                    }
                  />
                </Col>
              ))}
            </Row>
          )}
        </Space>
      </Card>

      {retired.length > 0 && (
        <Card size="small" title={`Retired (${retired.length})`}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Not researched, and kept rather than deleted for two reasons: the work filed under them stays
              attributed on the scoreboard, and the agent is refused if it suggests one of these again. Click one to
              review or bring it back.
            </Typography.Text>
            <Space wrap size={[8, 8]}>
              {retired.map((goal) => (
                <Tag
                  key={goal.id}
                  style={{ cursor: 'pointer', marginInlineEnd: 0, paddingBlock: 3 }}
                  onClick={() => navigate(`/goals/${goal.id}`)}
                >
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

/** Past this many quiet cycles the research prompt starts asking for an adjacent angle instead. */
const STALE_AFTER_EMPTY_CYCLES = 3

/** Roughly three lines of brief; past that the card gets a Show more toggle. */
const BRIEF_COLLAPSED_HEIGHT = 66

/**
 * Whether `ref`'s content is actually taller than the clamp — i.e. whether there is anything
 * to show more *of*. Most briefs are one line, and offering the toggle on all of them made it
 * meaningless: a control that does nothing on most cards teaches you to ignore it on the ones
 * where it matters.
 *
 * Measured rather than estimated from the text length, since how many lines a brief wraps to
 * depends on the card's width, which depends on the viewport.
 *
 * Two details keep the measurement stable. The observed element keeps `overflow: hidden` in
 * both states (only `maxHeight` is toggled), so it always establishes a block formatting
 * context — otherwise the child's margins would collapse out of it once expanded and
 * `scrollHeight` would read short, retracting the Show less button and stranding the reader.
 * And the ResizeObserver fires on the *width* change when a card is resized, which is what a
 * height-clamped element can still report.
 */
function useOverflows(ref: React.RefObject<HTMLElement | null>, maxHeight: number, content: string) {
  const [overflows, setOverflows] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setOverflows(el.scrollHeight > maxHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, maxHeight, content])

  return overflows
}

function GoalCard({
  goal,
  health,
  consoleOnly,
  busy,
  onEdit,
  onToggleStatus,
}: {
  goal: GoalRow
  health: GoalHealth | undefined
  consoleOnly: boolean
  busy: boolean
  onEdit: () => void
  onToggleStatus: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const brief = goal.brief?.trim() ?? ''
  const briefRef = useRef<HTMLDivElement>(null)
  const briefOverflows = useOverflows(briefRef, BRIEF_COLLAPSED_HEIGHT, brief)
  const stale = (health?.empty_cycles ?? 0) >= STALE_AFTER_EMPTY_CYCLES
  const paused = goal.status === 'paused'

  return (
    <Card
      size="small"
      style={{ height: '100%', opacity: paused ? 0.75 : 1 }}
      styles={{ body: { height: '100%', display: 'flex', flexDirection: 'column', gap: 12 } }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {/* minWidth:0 is what actually lets the title truncate — without it the flex item
            refuses to shrink below its content and pushes the buttons off the card. */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Tooltip title={goal.title}>
            <div
              style={{
                fontWeight: 600,
                fontSize: 15,
                lineHeight: 1.35,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {goal.title}
            </div>
          </Tooltip>
          <Space size={[6, 6]} wrap style={{ marginTop: 8 }}>
            <StatusTag status={goal.status} />
            {goal.origin === 'agent' && <Tag style={{ marginInlineEnd: 0 }}>agent-suggested</Tag>}
            {goal.weight !== 1 && <Tag style={{ marginInlineEnd: 0 }}>weight {goal.weight}</Tag>}
            {stale && !paused && (
              <Tooltip title={`${health?.empty_cycles} cycles without a proposal — the lane may be worked out.`}>
                <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                  going quiet
                </Tag>
              </Tooltip>
            )}
          </Space>
        </div>
        <Space size={4}>
          <Tooltip title="Edit title, brief and weight">
            <Button size="small" icon={<EditOutlined />} onClick={onEdit} />
          </Tooltip>
          <Tooltip
            title={
              consoleOnly
                ? READ_ONLY_HINT
                : paused
                  ? 'Resume researching this lane'
                  : 'Stop researching this without deleting its history'
            }
          >
            <Button
              size="small"
              icon={paused ? <PlayCircleOutlined /> : <PauseOutlined />}
              disabled={consoleOnly}
              loading={busy}
              onClick={onToggleStatus}
            />
          </Tooltip>
        </Space>
      </div>

      {brief ? (
        <div>
          <div
            ref={briefRef}
            style={{
              maxHeight: expanded || !briefOverflows ? undefined : BRIEF_COLLAPSED_HEIGHT,
              // Kept in both states so the block formatting context — and with it the
              // scrollHeight useOverflows reads — doesn't change when the card expands.
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <MarkdownLite text={brief} style={{ fontSize: 13, color: palette.textMuted }} />
            {!expanded && briefOverflows && <FadeOut />}
          </div>
          {briefOverflows && (
            <Button
              type="link"
              size="small"
              style={{ padding: 0, height: 'auto', fontSize: 12 }}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </Button>
          )}
        </div>
      ) : (
        <Typography.Text type="secondary" italic style={{ fontSize: 13 }}>
          No brief — the research prompt gets the title alone.
        </Typography.Text>
      )}

      {/* Pinned to the bottom so metrics align across a row of unequal briefs. */}
      <div style={{ marginTop: 'auto' }}>
        {health ? <GoalHealthRow health={health} stale={stale} /> : null}
      </div>
    </Card>
  )
}

/** Softens the clamp instead of chopping a line in half. Paints to the card's own background. */
function FadeOut() {
  const style: CSSProperties = {
    position: 'absolute',
    insetInline: 0,
    bottom: 0,
    height: 24,
    background: `linear-gradient(to bottom, transparent, ${palette.bgRaised})`,
    pointerEvents: 'none',
  }
  return <div style={style} />
}

function StatusTag({ status }: { status: GoalStatus }) {
  // Preset names only. See the layout note at the top of this file.
  const color: Record<GoalStatus, string | undefined> = {
    active: 'success',
    paused: 'warning',
    suggested: 'processing',
    retired: 'default',
  }
  return <Tag color={color[status]} style={{ marginInlineEnd: 0 }}>{status}</Tag>
}

/**
 * The numbers that answer "is this lane still worth researching?" — previously invisible, which
 * made a goal that had gone quiet look exactly like one nobody had gotten to yet.
 *
 * Hand-rolled rather than AntD `Statistic`: five of those in a row is a lot of vertical weight
 * for five small integers, and its label color is the dim tertiary token, which is what made
 * these unreadable against the card.
 */
function GoalHealthRow({ health, stale }: { health: GoalHealth; stale: boolean }) {
  return (
    <div style={{ borderTop: `1px solid ${palette.border}`, paddingTop: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 22px' }}>
        <Metric label="Proposals" value={health.proposals} />
        <Metric label="Approved" value={health.approved} />
        <Metric label="Shipped" value={health.shipped} />
        <Metric label="Spend" value={money(health.api_spend)} />
        <Metric
          label="Empty cycles"
          value={health.empty_cycles}
          tone={stale ? palette.rejected : undefined}
          hint="Research cycles since this goal last produced a proposal. Past three, the research prompt starts asking for an adjacent angle or a goal_suggest instead of more of the same."
        />
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
        {health.last_proposal_at
          ? `Last proposal ${timeAgo(health.last_proposal_at)}`
          : 'No proposals from this lane yet'}
      </Typography.Text>
    </div>
  )
}

function Metric({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: ReactNode
  tone?: string
  hint?: string
}) {
  const body = (
    <div style={{ minWidth: 62 }}>
      <div
        style={{
          fontSize: 10,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: palette.textMuted,
          marginBottom: 2,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
      <div className="mono" style={{ fontSize: 16, lineHeight: 1.2, color: tone ?? palette.textPrimary }}>
        {value}
      </div>
    </div>
  )
  return hint ? <Tooltip title={hint}>{body}</Tooltip> : body
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
  const isRetired = goal?.status === 'retired'

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
          <Tooltip title={consoleOnly ? READ_ONLY_HINT : undefined}>
            <Button
              type="primary"
              disabled={!title.trim() || consoleOnly}
              onClick={() =>
                void onSave({
                  title: title.trim(),
                  brief,
                  weight,
                  ...(isSuggestion || isRetired ? { status: 'active' as const } : {}),
                })
              }
            >
              {isSuggestion ? 'Save and accept' : isRetired ? 'Save and reactivate' : 'Save'}
            </Button>
          </Tooltip>
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
        {isRetired && (
          <Alert
            type="warning"
            showIcon
            message="This goal is retired — saving brings it back into the rotation."
          />
        )}
        <div>
          <Typography.Text strong>Title</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
            Short and stable. This is the grouping key on the Economics scoreboard, and what the agent is told to
            echo back verbatim when it files a proposal or a lesson — so renaming it splits the history.
          </Typography.Paragraph>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Swedish market"
            showCount
            maxLength={80}
          />
        </div>
        <div>
          <Typography.Text strong>Brief</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
            Passed to the research prompt word for word. Markdown is fine. Be specific about what counts and what
            doesn't — which markets, which buyers, which incumbents to rule out first.
          </Typography.Paragraph>
          <Input.TextArea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            autoSize={{ minRows: 5, maxRows: 16 }}
            placeholder="Research in Swedish (svenska sökord, Flashback, r/sweden). Target enskild firma / aktiebolag pain points. Check Fortnox, Bokio and Visma before proposing something they already cover."
          />
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
