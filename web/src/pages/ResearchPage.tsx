import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { App, Badge, Button, Card, Empty, Input, Modal, Progress, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { MergeCellsOutlined } from '@ant-design/icons'
import type { DuplicateNotePair, ResearchNoteRow } from '../types'
import { api } from '../api'
import { markdownPreview, timeAgo } from '../format'
import { palette } from '../theme'
import { ResearchNoteDialog } from '../components/ResearchNoteDialog'
import { TableToolbar } from '../components/TableToolbar'
import { useTableView } from '../hooks/useTableView'
import { useTableKeyboardNav } from '../hooks/useTableKeyboardNav'
import { exportCsv, exportJson } from '../export'

/**
 * Near-duplicate notes, side by side, with one click to fold one into the other. Research runs
 * re-discover the same fact across cycles; without this the duplicates just accumulate and dilute
 * every later semantic search over the notes.
 */
function DuplicatesModal({
  open,
  onClose,
  onMerged,
}: {
  open: boolean
  onClose: () => void
  onMerged: () => void
}) {
  const { message } = App.useApp()
  const [pairs, setPairs] = useState<DuplicateNotePair[]>([])
  const [loading, setLoading] = useState(true)
  const [merging, setMerging] = useState<number | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    api
      .duplicateNotes()
      .then(setPairs)
      .catch(() => setPairs([]))
      .finally(() => setLoading(false))
  }, [open])

  async function merge(keep: ResearchNoteRow, drop: ResearchNoteRow) {
    setMerging(drop.id)
    try {
      await api.mergeResearchNotes(keep.id, [drop.id])
      message.success(`Merged #${drop.id} into #${keep.id}`)
      setPairs((prev) => prev.filter((p) => p.a.id !== drop.id && p.b.id !== drop.id))
      onMerged()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Merge failed')
    } finally {
      setMerging(null)
    }
  }

  function NoteSide({ note, other }: { note: ResearchNoteRow; other: ResearchNoteRow }) {
    return (
      <Card size="small" style={{ flex: 1, minWidth: 260 }}>
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Typography.Text strong>
            #{note.id} · {note.topic}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {markdownPreview(note.finding, 220)}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {note.source ?? 'no source'} · {timeAgo(note.fetched_at)}
          </Typography.Text>
          <Button
            size="small"
            icon={<MergeCellsOutlined />}
            loading={merging === other.id}
            onClick={() => merge(note, other)}
          >
            Keep this, merge #{other.id} in
          </Button>
        </Space>
      </Card>
    )
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={860} title="Near-duplicate research notes">
      {loading ? (
        <Typography.Text type="secondary">Scanning…</Typography.Text>
      ) : pairs.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No near-duplicates found" />
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Merging keeps the note you pick, appends any source the other had, and takes the higher confidence of the two.
          </Typography.Text>
          {pairs.map((pair) => (
            <div key={`${pair.a.id}-${pair.b.id}`}>
              <Tag color="warning" style={{ marginBottom: 6 }}>
                {Math.round(pair.similarity * 100)}% similar
              </Tag>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <NoteSide note={pair.a} other={pair.b} />
                <NoteSide note={pair.b} other={pair.a} />
              </div>
            </div>
          ))}
        </Space>
      )}
    </Modal>
  )
}

export function ResearchPage({ historyVersion }: { historyVersion: number }) {
  const navigate = useNavigate()
  const { id } = useParams()
  const [notes, setNotes] = useState<ResearchNoteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [duplicatesOpen, setDuplicatesOpen] = useState(false)
  const [duplicateCount, setDuplicateCount] = useState(0)
  const [localVersion, setLocalVersion] = useState(0)

  useEffect(() => {
    api
      .researchNotes()
      .then(setNotes)
      .finally(() => setLoading(false))
    api
      .duplicateNotes()
      .then((pairs) => setDuplicateCount(pairs.length))
      .catch(() => setDuplicateCount(0))
  }, [historyVersion, localVersion])

  const selected = id ? (notes.find((n) => n.id === Number(id)) ?? null) : null
  const openNote = useCallback((n: ResearchNoteRow) => navigate(`/research/${n.id}`), [navigate])
  const closeNote = useCallback(() => navigate('/research'), [navigate])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return notes
    return notes.filter((n) => `${n.topic} ${n.finding} ${n.source ?? ''}`.toLowerCase().includes(q))
  }, [notes, search])

  const { rowClassName } = useTableKeyboardNav<ResearchNoteRow>({
    rows: filtered,
    onOpen: openNote,
    enabled: selected === null && !duplicatesOpen,
  })

  const baseColumns = useMemo(
    () => [
      {
        title: 'Topic',
        dataIndex: 'topic',
        width: 220,
        ellipsis: true,
        sorter: (a: ResearchNoteRow, b: ResearchNoteRow) => a.topic.localeCompare(b.topic),
      },
      {
        title: 'Finding',
        dataIndex: 'finding',
        ellipsis: true,
        sorter: (a: ResearchNoteRow, b: ResearchNoteRow) => a.finding.localeCompare(b.finding),
        render: (v: string) => markdownPreview(v),
      },
      {
        title: 'Source',
        dataIndex: 'source',
        width: 220,
        ellipsis: true,
        sorter: (a: ResearchNoteRow, b: ResearchNoteRow) => (a.source ?? '').localeCompare(b.source ?? ''),
        render: (v: string | null) =>
          v ? (
            <a href={v} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              {v}
            </a>
          ) : (
            '—'
          ),
      },
      {
        title: 'Confidence',
        dataIndex: 'confidence',
        width: 120,
        sorter: (a: ResearchNoteRow, b: ResearchNoteRow) => (a.confidence ?? -1) - (b.confidence ?? -1),
        render: (v: number | null) => (v == null ? '—' : <Progress percent={Math.round(v * 100)} size="small" />),
      },
      {
        title: 'Fetched',
        dataIndex: 'fetched_at',
        width: 110,
        sorter: (a: ResearchNoteRow, b: ResearchNoteRow) =>
          new Date(a.fetched_at).getTime() - new Date(b.fetched_at).getTime(),
        defaultSortOrder: 'descend' as const,
        render: (v: string) => (
          <Tooltip title={new Date(v).toLocaleString()}>
            <span>{timeAgo(v)}</span>
          </Tooltip>
        ),
      },
    ],
    [],
  )

  const { columns, components, scroll, tableProps, view } = useTableView<ResearchNoteRow>('research-notes', baseColumns)

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space size={12} wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Input.Search
          allowClear
          placeholder="Search topic, finding, or source…"
          style={{ width: 360 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <TableToolbar
          view={view}
          onExportCsv={() =>
            exportCsv('research-notes', filtered, [
              { key: 'id', title: '#' },
              { key: 'topic', title: 'Topic' },
              { key: 'finding', title: 'Finding' },
              { key: 'source', title: 'Source' },
              { key: 'confidence', title: 'Confidence' },
              { key: 'fetched_at', title: 'Fetched' },
            ])
          }
          onExportJson={() => exportJson('research-notes', filtered)}
          extra={
            <Badge count={duplicateCount} size="small" color={palette.pending}>
              <Button icon={<MergeCellsOutlined />} onClick={() => setDuplicatesOpen(true)}>
                Duplicates
              </Button>
            </Badge>
          }
        />
      </Space>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={filtered}
        components={components}
        scroll={scroll}
        columns={columns}
        rowClassName={rowClassName}
        onRow={(n) => ({ onClick: () => openNote(n), style: { cursor: 'pointer' } })}
        {...tableProps}
      />

      <ResearchNoteDialog
        note={selected}
        open={selected !== null}
        onClose={closeNote}
        onChanged={() => setLocalVersion((v) => v + 1)}
      />
      <DuplicatesModal
        open={duplicatesOpen}
        onClose={() => setDuplicatesOpen(false)}
        onMerged={() => setLocalVersion((v) => v + 1)}
      />
    </Space>
  )
}
