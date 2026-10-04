import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { App, Alert, Button, Card, Empty, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { PlayCircleOutlined, StopOutlined } from '@ant-design/icons'
import type { BuildQueue, DurationForecast, FeedEntry, QueuedBuild } from '../types'
import { api } from '../api'
import { READ_ONLY_HINT, useConsoleOnly } from '../consoleOnly'
import { PRIORITY_LABEL, PRIORITY_TAG_COLOR, inWords, markdownPreview } from '../format'
import { LiveConsole } from '../components/LiveConsole'
import { useTableView } from '../hooks/useTableView'
import { TableToolbar } from '../components/TableToolbar'
import { palette } from '../theme'

const { Text, Title } = Typography

/** Ticks once a second so the elapsed clock on a running deep dive actually moves. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

/**
 * Median plus range plus sample size, never a bare number.
 *
 * Real phases in this agent's ledger have run anywhere from 8 to 32 minutes. A single
 * "estimated 12 minutes" would be wrong nearly every time and would be believed anyway; showing
 * the spread is what makes it a forecast rather than a promise. The ledger key is `act`, which
 * includes the build-mode runs from before this agent became research-only.
 */
function ForecastLine({ forecast, allModels }: { forecast: DurationForecast; allModels: DurationForecast }) {
  // Falls back to the all-model figure when the pinned model has no history of its own, which is
  // exactly the situation right after switching models -- the moment you most want an estimate.
  const shown = forecast.samples > 0 ? forecast : allModels
  const scope = forecast.samples > 0 ? 'this model' : 'all models'

  if (shown.samples === 0 || shown.medianMs === null) {
    return (
      <Text type="secondary" style={{ fontSize: 12 }}>
        No completed deep dives yet — no basis for an estimate.
      </Text>
    )
  }
  return (
    <Text type="secondary" style={{ fontSize: 12 }}>
      Typically <Text strong>{duration(shown.medianMs)}</Text> per deep dive — median of the last {shown.samples}{' '}
      {shown.samples === 1 ? 'run' : 'runs'} on {scope}, ranging {duration(shown.minMs ?? 0)} to{' '}
      {duration(shown.maxMs ?? 0)}.
    </Text>
  )
}

function RunningDeepDive({
  running,
  feed,
  elapsedMs,
  onAbort,
  onOpen,
}: {
  running: NonNullable<BuildQueue['running']>
  feed: FeedEntry[]
  elapsedMs: number | null
  onAbort: () => void
  onOpen: () => void
}) {
  const readOnly = useConsoleOnly()

  // The deep dive's log. Not a new stream -- the activity feed already carries every tool call
  // and every line of model text with the proposal id on it, so this is that feed narrowed to
  // the one idea. `phase_start` is kept because "deep dive started" is the first line you want.
  const log = useMemo(
    () =>
      feed.filter((entry) => {
        const event = entry.event
        return 'proposalId' in event && event.proposalId === running.proposalId
      }),
    [feed, running.proposalId]
  )

  return (
    <Card
      style={{ background: palette.bgRaised, borderLeft: `3px solid ${palette.active}` }}
      styles={{ body: { padding: 18, display: 'flex', flexDirection: 'column', gap: 12 } }}
    >
      <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <div>
          <Space align="center" size={8} wrap>
            {/* Same live indicator the rest of the console uses; index.css turns the animation
                off under prefers-reduced-motion. */}
            <span
              className="status-dot-live"
              style={{ width: 8, height: 8, borderRadius: '50%', background: palette.active, display: 'inline-block' }}
            />
            <Title level={5} style={{ margin: 0 }}>
              Investigating idea #{running.proposalId}
            </Title>
            <Tag color={PRIORITY_TAG_COLOR[running.priority]}>{PRIORITY_LABEL[running.priority]}</Tag>
            <Tag>{running.domain}</Tag>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {markdownPreview(running.description, 160)}
          </Text>
        </div>
        <Space size={8}>
          <Text className="mono" style={{ fontSize: 20, color: palette.active }}>
            {elapsedMs === null ? '—' : duration(elapsedMs)}
          </Text>
          <Button size="small" onClick={onOpen}>
            Open idea
          </Button>
          <Tooltip title={readOnly ? READ_ONLY_HINT : 'Stop this deep dive. Notes it already saved stay; no report is filed.'}>
            <Button size="small" danger ghost icon={<StopOutlined />} disabled={readOnly} onClick={onAbort}>
              Abort
            </Button>
          </Tooltip>
        </Space>
      </Space>

      {running.model && (
        <Text type="secondary" className="mono" style={{ fontSize: 12 }}>
          {running.model}
        </Text>
      )}

      <LiveConsole feed={log} height={320} />
    </Card>
  )
}

/**
 * The deep-dive queue: which approved idea is being investigated, what is queued behind it, and
 * what is due later.
 *
 * The Dashboard says a phase is running, the Live feed says what it is doing, and Ideas says
 * what was approved -- but "what is the agent going to investigate, in what order, and how long
 * will it take" lives in an in-memory queue only this page exposes.
 */
export function DeepDiveQueuePage({ feed, historyVersion }: { feed: FeedEntry[]; historyVersion: number }) {
  const navigate = useNavigate()
  const { message, modal } = App.useApp()
  const readOnly = useConsoleOnly()
  const [queue, setQueue] = useState<BuildQueue | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Polled as well as refetched on socket events: the queue is in-process state that changes
  // when the worker picks something up, and no event is emitted for that. A stale queue view is
  // the specific thing this page must not be.
  useEffect(() => {
    let cancelled = false
    const load = () =>
      api
        .queue()
        .then((q) => !cancelled && (setQueue(q), setError(null)))
        .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    void load()
    const timer = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [historyVersion])

  const running = queue?.running ?? null
  const now = useNow(Boolean(running))
  const elapsedMs = running?.startedAt ? now - new Date(running.startedAt).getTime() : null

  async function abort() {
    if (!running) return
    modal.confirm({
      title: `Abort the deep dive on idea #${running.proposalId}?`,
      content:
        'Nothing it does has side effects; notes it already saved stay, and no report is filed. It will be marked interrupted and will not re-run on its own.',
      okText: 'Abort deep dive',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.abort(running.proposalId)
          message.success('Abort requested')
        } catch (err) {
          message.error(err instanceof Error ? err.message : 'Abort failed')
        }
      },
    })
  }

  // useCallback because the stalled table's column set memoizes on it -- a function rebuilt every
  // render would rebuild the columns every render, and useTableView assigns column keys from that
  // list, so the stored widths would churn.
  const rerun = useCallback(
    async (proposalId: number) => {
      try {
        await api.rerunDeepDive(proposalId)
        message.success(`Deep dive queued — idea #${proposalId} runs on the next scheduler tick`)
      } catch (err) {
        message.error(err instanceof Error ? err.message : 'Queueing the deep dive failed')
      }
    },
    [message]
  )

  const columns = useMemo(
    () => [
      {
        title: '#',
        dataIndex: 'proposalId',
        width: 70,
        render: (id: number) => (
          <a onClick={() => navigate(`/proposals/${id}`)} className="mono">
            #{id}
          </a>
        ),
      },
      { title: 'Goal', dataIndex: 'domain', width: 200, ellipsis: true },
      {
        title: 'Idea',
        dataIndex: 'description',
        ellipsis: true,
        render: (text: string) => markdownPreview(text, 200),
      },
      {
        title: 'Priority',
        dataIndex: 'priority',
        width: 110,
        render: (p: QueuedBuild['priority']) => <Tag color={PRIORITY_TAG_COLOR[p]}>{PRIORITY_LABEL[p]}</Tag>,
      },
      {
        title: 'Due',
        dataIndex: 'nextRunAt',
        width: 150,
        render: (at: string | null) => (at ? <Tooltip title={new Date(at).toLocaleString()}>{inWords(at)}</Tooltip> : '—'),
      },
      {
        title: 'Last attempt',
        dataIndex: 'actStatus',
        width: 130,
        render: (status: QueuedBuild['actStatus']) =>
          status ? <Tag color={status === 'complete' ? 'success' : 'error'}>{status}</Tag> : <Text type="secondary">never ran</Text>,
      },
    ],
    [navigate]
  )

  const queuedView = useTableView('builds-queued', columns)
  const scheduledView = useTableView('builds-scheduled', columns)
  // Its own column set: the point of this table is the button, and "Due" is always empty here
  // by definition -- an unfinished deep dive here is precisely one with no next_run_at.
  const stalledView = useTableView(
    'builds-stalled',
    useMemo(
      () => [
        ...columns.filter((c) => c.dataIndex !== 'nextRunAt'),
        {
          title: '',
          dataIndex: 'proposalId',
          key: 'retry',
          width: 130,
          render: (id: number) => (
            <Tooltip title={readOnly ? READ_ONLY_HINT : 'Queue this deep dive to run again'}>
              <Button size="small" type="primary" ghost icon={<PlayCircleOutlined />} disabled={readOnly} onClick={() => rerun(id)}>
                Retry
              </Button>
            </Tooltip>
          ),
        },
      ],
      [columns, readOnly, rerun]
    )
  )

  if (error) return <Alert type="error" showIcon message="Could not load the deep-dive queue" description={error} />

  const queued = queue?.queued ?? []
  const scheduled = queue?.scheduled ?? []
  const stalled = queue?.stalled ?? []

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <div>
        <Title level={4} style={{ marginBottom: 4 }}>
          Deep-dive queue
        </Title>
        {queue && <ForecastLine forecast={queue.forecast} allModels={queue.forecastAllModels} />}
      </div>

      {running ? (
        <RunningDeepDive
          running={running}
          feed={feed}
          elapsedMs={elapsedMs}
          onAbort={abort}
          onOpen={() => navigate(`/proposals/${running.proposalId}`)}
        />
      ) : (
        <Card style={{ background: palette.bgRaised }} styles={{ body: { padding: 18 } }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              queued.length > 0
                ? 'Nothing running right now — the worker picks the next one up within about 15 seconds.'
                : 'Nothing running, and nothing queued. Approve an idea to start a deep dive on it.'
            }
          />
        </Card>
      )}

      <div>
        <Space align="center" style={{ marginBottom: 8 }}>
          <Title level={5} style={{ margin: 0 }}>
            Up next
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {queued.length} waiting · runs one at a time, in this order
          </Text>
        </Space>
        <TableToolbar view={queuedView.view} />
        <Table
          {...queuedView.tableProps}
          columns={queuedView.columns}
          components={queuedView.components}
          scroll={queuedView.scroll}
          rowKey="proposalId"
          dataSource={queued}
          size="small"
          pagination={false}
          locale={{ emptyText: 'Nothing queued.' }}
        />
      </div>

      <div>
        <Space align="center" style={{ marginBottom: 8 }}>
          <Title level={5} style={{ margin: 0 }}>
            Scheduled later
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            approved and dated — the scheduler moves these into the queue when they come due
          </Text>
        </Space>
        <TableToolbar view={scheduledView.view} />
        <Table
          {...scheduledView.tableProps}
          columns={scheduledView.columns}
          components={scheduledView.components}
          scroll={scheduledView.scroll}
          rowKey="proposalId"
          dataSource={scheduled}
          size="small"
          pagination={false}
          locale={{ emptyText: 'Nothing scheduled.' }}
        />
      </div>

      <div>
        <Space align="center" style={{ marginBottom: 8 }} wrap>
          <Title level={5} style={{ margin: 0 }}>
            Unfinished deep dives
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            approved, no report, and nothing will run it: a deep dive that stopped waits here until you retry it
          </Text>
        </Space>
        <Table
          {...stalledView.tableProps}
          columns={stalledView.columns}
          components={stalledView.components}
          scroll={stalledView.scroll}
          rowKey="proposalId"
          dataSource={stalled}
          size="small"
          pagination={false}
          locale={{ emptyText: 'Nothing unfinished — every approved idea has a report or is queued.' }}
        />
      </div>
    </Space>
  )
}

/** Kept exported so the page can be lazy-loaded alongside every other route. */
export default DeepDiveQueuePage
