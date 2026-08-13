import { useEffect, useMemo, useState } from 'react'
import { Input, Progress, Space, Table } from 'antd'
import type { ResearchNoteRow } from '../types'
import { api } from '../api'
import { markdownPreview, timeAgo } from '../format'
import { ResearchNoteDialog } from '../components/ResearchNoteDialog'
import { useResizableColumns } from '../hooks/useResizableColumns'

export function ResearchPage({ historyVersion }: { historyVersion: number }) {
  const [notes, setNotes] = useState<ResearchNoteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ResearchNoteRow | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    api
      .researchNotes()
      .then(setNotes)
      .finally(() => setLoading(false))
  }, [historyVersion])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return notes
    return notes.filter((n) => `${n.topic} ${n.finding} ${n.source ?? ''}`.toLowerCase().includes(q))
  }, [notes, search])

  const { columns, components, scroll } = useResizableColumns<ResearchNoteRow>('research-notes', [
    {
      title: 'Topic',
      dataIndex: 'topic',
      width: 220,
      ellipsis: true,
      sorter: (a, b) => a.topic.localeCompare(b.topic),
    },
    {
      title: 'Finding',
      dataIndex: 'finding',
      ellipsis: true,
      sorter: (a, b) => a.finding.localeCompare(b.finding),
      render: (v: string) => markdownPreview(v),
    },
    {
      title: 'Source',
      dataIndex: 'source',
      width: 220,
      ellipsis: true,
      sorter: (a, b) => (a.source ?? '').localeCompare(b.source ?? ''),
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
      sorter: (a, b) => (a.confidence ?? -1) - (b.confidence ?? -1),
      render: (v: number | null) => (v == null ? '—' : <Progress percent={Math.round(v * 100)} size="small" />),
    },
    {
      title: 'Fetched',
      dataIndex: 'fetched_at',
      width: 110,
      sorter: (a, b) => new Date(a.fetched_at).getTime() - new Date(b.fetched_at).getTime(),
      defaultSortOrder: 'descend',
      render: (v: string) => timeAgo(v),
    },
  ])

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Input.Search
        allowClear
        placeholder="Search topic, finding, or source…"
        style={{ maxWidth: 360 }}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <Table
        rowKey="id"
        loading={loading}
        dataSource={filtered}
        pagination={{ pageSize: 10 }}
        components={components}
        scroll={scroll}
        onRow={(n) => ({ onClick: () => setSelected(n), style: { cursor: 'pointer' } })}
        columns={columns}
      />
      <ResearchNoteDialog note={selected} open={selected !== null} onClose={() => setSelected(null)} />
    </Space>
  )
}
