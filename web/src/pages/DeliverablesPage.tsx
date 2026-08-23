import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CloudUploadOutlined,
  CreditCardOutlined,
  GithubOutlined,
  GlobalOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  PullRequestOutlined,
} from '@ant-design/icons'
import { Alert, App, Button, Card, Empty, Input, Segmented, Select, Space, Spin, Tag, Tooltip, Typography } from 'antd'
import type { Deliverable, DeliverableArtifact, ProposalRow } from '../types'
import { api } from '../api'
import { READ_ONLY_HINT, useConsoleOnly } from '../consoleOnly'
import { UNFINISHED_ACT, rerunConfirm, rerunLabel } from '../actStatus'
import { markdownPreview, money, timeAgo } from '../format'
import { MarkdownLite } from '../components/MarkdownLite'
import { palette } from '../theme'

const { Text, Title } = Typography

type Filter = 'all' | 'live' | 'unreviewed'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Everything built' },
  { value: 'live', label: 'Has a live URL' },
  { value: 'unreviewed', label: 'Not yet reviewed' },
]

const REVIEW_OPTIONS = [
  { value: 'unreviewed', label: 'Unreviewed' },
  { value: 'mvp_done', label: '✓ MVP done' },
  { value: 'needs_refinement', label: '⚠ Needs refinement' },
]

// UNFINISHED_ACT / canRerun / rerunLabel / rerunConfirm live in ../actStatus so this page and
// ProposalDialog agree on what "unfinished" means, offer the same control for it, and ask the
// same question before re-running something that already finished.

function artifactIcon(artifact: DeliverableArtifact) {
  if (artifact.kind === 'payment_link') return <CreditCardOutlined />
  if (artifact.kind === 'pull_request') return <PullRequestOutlined />
  if (artifact.kind === 'repo') return <GithubOutlined />
  return artifact.provider === 'vercel' ? <CloudUploadOutlined /> : <GlobalOutlined />
}

/**
 * Every artifact is a real anchor, not a row you have to expand to reach. The primary one
 * (the live site if there is one, else the repo) is the filled button -- this page exists
 * because that link was three interactions deep on the Actions page.
 */
function ArtifactLinks({ deliverable }: { deliverable: Deliverable }) {
  const primaryUrl = deliverable.siteUrl ?? deliverable.repoUrl
  return (
    <Space size={8} wrap>
      {deliverable.artifacts.map((artifact) => (
        <Button
          key={`${artifact.kind}-${artifact.url}`}
          type={artifact.url === primaryUrl ? 'primary' : 'default'}
          size="small"
          icon={artifactIcon(artifact)}
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
        >
          {artifact.label}
          {artifact.detail ? ` · ${artifact.detail}` : ''}
        </Button>
      ))}
    </Space>
  )
}

/**
 * Model-authored text is long -- a proposal description runs to several paragraphs and an
 * outcome note to several more. Expanded in place on click, never in a tooltip: a hover
 * overlay holding that much text covers the cards either side of it, and can't be scrolled
 * or dismissed deliberately.
 */
function ClampedText({
  text,
  collapsedChars,
  moreLabel,
  secondary,
}: {
  text: string
  collapsedChars: number
  moreLabel: string
  secondary?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const short = markdownPreview(text, collapsedChars)
  const truncated = short !== markdownPreview(text, text.length)
  const fontSize = secondary ? 12 : 13

  return (
    <div>
      {expanded ? (
        <MarkdownLite text={text} style={{ fontSize, color: secondary ? palette.textMuted : undefined }} />
      ) : (
        <Text type={secondary ? 'secondary' : undefined} style={{ fontSize }}>
          {short}
        </Text>
      )}
      {(truncated || expanded) && (
        <Button type="link" size="small" style={{ padding: 0, height: 20 }} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Less' : moreLabel}
        </Button>
      )}
    </div>
  )
}

function DeliverableCard({
  deliverable,
  onSetReview,
  onOpenTrail,
  onOpenProposal,
  onRerun,
}: {
  deliverable: Deliverable
  onSetReview: (id: number, reviewStatus: ProposalRow['review_status']) => void
  onOpenTrail: (proposalId: number) => void
  onOpenProposal: (proposalId: number) => void
  onRerun?: (proposalId: number, actStatus: Deliverable['actStatus']) => void
}) {
  const readOnly = useConsoleOnly()
  const { outcome } = deliverable
  return (
    <Card
      style={{
        background: palette.bgRaised,
        // The one thing the operator wants at a glance: did this end up somewhere reachable?
        // An unfinished build outranks that -- a card that looks shipped and isn't is the
        // failure this page had with proposal #27, whose repo was empty the whole time.
        borderLeft: `3px solid ${
          UNFINISHED_ACT[deliverable.actStatus ?? '']
            ? palette.rejected
            : deliverable.siteUrl
              ? palette.approved
              : palette.border
        }`,
      }}
      styles={{ body: { padding: 18, display: 'flex', flexDirection: 'column', gap: 12, height: '100%' } }}
    >
      <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }}>
        <div>
          <Title level={5} className="mono" style={{ margin: 0 }}>
            {deliverable.name ?? `Proposal #${deliverable.proposalId}`}
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {deliverable.domain}
          </Text>
        </div>
        <Space size={4}>
          {/* Ahead of the outcome tag on purpose: "the build didn't finish" changes how you
              read every other number on the card, including a self-reported success. */}
          {UNFINISHED_ACT[deliverable.actStatus ?? ''] && (
            <Tooltip title={UNFINISHED_ACT[deliverable.actStatus ?? '']}>
              <Tag color="error" style={{ marginInlineEnd: 0 }}>
                {deliverable.actStatus}
              </Tag>
            </Tooltip>
          )}
          {outcome && <Tag color={outcome.success ? 'success' : 'error'}>{outcome.success ? 'ok' : 'failed'}</Tag>}
          {/* The proposal this came from, rendered in full by ProposalDialog -- which is where
              long model prose belongs, rather than expanded inside a card in a grid. */}
          <Tooltip title="Open the proposal behind this">
            <Tag style={{ cursor: 'pointer', marginInlineEnd: 0 }} onClick={() => onOpenProposal(deliverable.proposalId)}>
              #{deliverable.proposalId}
            </Tag>
          </Tooltip>
        </Space>
      </Space>

      <ClampedText text={deliverable.description} collapsedChars={180} moreLabel="What this was meant to be" />

      <ArtifactLinks deliverable={deliverable} />

      {outcome?.notes && (
        <ClampedText text={outcome.notes} collapsedChars={140} moreLabel="Agent’s notes on this build" secondary />
      )}

      <Space size={12} wrap style={{ marginTop: 'auto', fontSize: 12 }}>
        <Text type="secondary" className="mono" style={{ fontSize: 12 }}>
          {deliverable.filesCommitted} files · {deliverable.commits} commits
        </Text>
        {outcome && (outcome.revenue > 0 || outcome.cost > 0) && (
          <Text type="secondary" className="mono" style={{ fontSize: 12 }}>
            {money(outcome.revenue)} in · {money(outcome.cost)} out
          </Text>
        )}
        <Tooltip title={new Date(deliverable.lastActivityAt).toLocaleString()}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            built {timeAgo(deliverable.lastActivityAt)}
          </Text>
        </Tooltip>
      </Space>

      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        {/* Same verdict the Actions page sets -- this is where you'd form it, having just opened the thing. */}
        <Tooltip title={readOnly ? READ_ONLY_HINT : undefined}>
          <Select<'unreviewed' | 'mvp_done' | 'needs_refinement'>
            size="small"
            style={{ width: 168 }}
            value={deliverable.reviewStatus ?? 'unreviewed'}
            disabled={readOnly}
            onChange={(v) => onSetReview(deliverable.proposalId, v === 'unreviewed' ? null : v)}
            options={REVIEW_OPTIONS}
          />
        </Tooltip>
        <Space size={4}>
          {/* The point of putting it here: this card *is* the empty repo. Finding out the build
              stopped and being able to restart it should not be two different screens.

              Offered on every card that isn't mid-run, not only ones the badge calls unfinished.
              `actStatus` is null for any act phase that ran before the column existed -- #27 and
              #15/#16/#17 among them -- and gating the button on the badge made re-running exactly
              the oldest stuck builds impossible. Every card here is an approved proposal by
              construction (`listDeliverableActions` filters on it), so there is nothing else to
              check; `rerunLabel` says whether this is a retry or a deliberate re-run. */}
          {onRerun && deliverable.actStatus !== 'running' && (
            <Tooltip title={readOnly ? READ_ONLY_HINT : 'Queue this build to run again'}>
              <Button
                size="small"
                type="primary"
                ghost
                icon={<PlayCircleOutlined />}
                disabled={readOnly}
                onClick={() => onRerun(deliverable.proposalId, deliverable.actStatus)}
              >
                {rerunLabel(deliverable.actStatus)}
              </Button>
            </Tooltip>
          )}
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => onOpenTrail(deliverable.proposalId)}>
            {deliverable.actionCount} actions →
          </Button>
        </Space>
      </Space>
    </Card>
  )
}

/**
 * What the agent has actually built, one card per approved proposal that produced something
 * reachable. The Actions page answers "what did it do, step by step"; this answers "what is
 * there now, and where do I click to see it" without expanding a row or opening a dialog.
 */
export function DeliverablesPage({
  historyVersion,
  proposals,
  onSetReview,
}: {
  historyVersion: number
  proposals: ProposalRow[]
  onSetReview: (id: number, reviewStatus: ProposalRow['review_status']) => void
}) {
  const navigate = useNavigate()
  const { message, modal } = App.useApp()
  const [deliverables, setDeliverables] = useState<Deliverable[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')

  async function rerun(proposalId: number, actStatus: Deliverable['actStatus']) {
    // A finished build is re-run deliberately or not at all -- see rerunConfirm.
    const confirm = rerunConfirm(actStatus)
    if (confirm) {
      modal.confirm({ ...confirm, onOk: () => dispatchRerun(proposalId) })
      return
    }
    await dispatchRerun(proposalId)
  }

  async function dispatchRerun(proposalId: number) {
    try {
      await api.rerunBuild(proposalId)
      // "Queued", not "started" -- the scheduler picks it up on its own tick, and saying it's
      // running sends someone looking for output that doesn't exist yet.
      message.success(`Build queued — proposal #${proposalId} runs on the next scheduler tick`)
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Queueing the build failed')
    }
  }

  useEffect(() => {
    api
      .deliverables()
      .then((rows) => {
        setDeliverables(rows)
        setError(null)
      })
      // Held and shown rather than swallowed: "the request failed" and "nothing has been
      // built" produce the same empty grid, and only one of them is the agent's fault.
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [historyVersion])

  // The review status lives on the proposal, and App owns that list -- so an edit made here
  // (or on the Actions page) is reflected without refetching this page's own data.
  //
  // The proposal wins whenever it's present, including when it says null: null is a real
  // value here ("unreviewed"), not a missing one, so `??` would fall back to this page's
  // stale copy and make setting a card back to Unreviewed look like it did nothing.
  const withCurrentReview = useMemo(() => {
    const byId = new Map(proposals.map((p) => [p.id, p]))
    return deliverables.map((d) => {
      const proposal = byId.get(d.proposalId)
      return { ...d, reviewStatus: proposal ? proposal.review_status : d.reviewStatus }
    })
  }, [deliverables, proposals])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return withCurrentReview.filter((d) => {
      if (filter === 'live' && !d.siteUrl) return false
      if (filter === 'unreviewed' && d.reviewStatus !== null) return false
      if (!q) return true
      const haystack = [d.name ?? '', d.domain, d.description, ...d.artifacts.map((a) => `${a.label} ${a.url}`)]
      return haystack.join(' ').toLowerCase().includes(q)
    })
  }, [withCurrentReview, filter, search])

  const liveCount = withCurrentReview.filter((d) => d.siteUrl).length
  const repoCount = withCurrentReview.filter((d) => d.repoUrl).length

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space size={12} wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Space size={16} wrap>
          <Segmented value={filter} onChange={(v) => setFilter(v as Filter)} options={FILTERS} />
          <Input.Search
            allowClear
            placeholder="Search name, domain, or URL…"
            style={{ width: 300 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {withCurrentReview.length} built · {liveCount} with a live URL · {repoCount} with a repo
        </Text>
      </Space>

      {error !== null && (
        <Alert
          type="error"
          showIcon
          message="Couldn't load deliverables"
          description={`${error} — if the backend is running an older build, restart it (npm start); the endpoint is GET /api/deliverables.`}
        />
      )}

      {shown.length === 0 ? (
        <Empty
          description={
            error !== null
              ? 'Nothing to show — the request above failed.'
              : withCurrentReview.length === 0
                ? 'Nothing built yet — approved proposals that create a repo or deploy a site show up here.'
                : 'No deliverables match this filter.'
          }
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 }}>
          {shown.map((d) => (
            <DeliverableCard
              key={d.proposalId}
              deliverable={d}
              onSetReview={onSetReview}
              onOpenTrail={(id) => navigate(`/actions/${id}`)}
              onOpenProposal={(id) => navigate(`/proposals/${id}`)}
              onRerun={rerun}
            />
          ))}
        </div>
      )}

      <Text type="secondary" style={{ fontSize: 12 }}>
        <LinkOutlined /> Every link here comes from the tool result that created it — see the full call trail on the
        Actions page.
      </Text>
    </Space>
  )
}
