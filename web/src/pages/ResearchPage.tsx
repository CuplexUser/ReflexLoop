import { useEffect, useState } from 'react'
import { Progress, Table } from 'antd'
import type { ResearchNoteRow } from '../types'
import { api } from '../api'
import { timeAgo } from '../format'
import { ResearchNoteDialog } from '../components/ResearchNoteDialog'

export function ResearchPage({ historyVersion }: { historyVersion: number }) {
  const [notes, setNotes] = useState<ResearchNoteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ResearchNoteRow | null>(null)

  useEffect(() => {
    api
      .researchNotes()
      .then(setNotes)
      .finally(() => setLoading(false))
  }, [historyVersion])

  return (
    <>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={notes}
        pagination={{ pageSize: 10 }}
        onRow={(n) => ({ onClick: () => setSelected(n), style: { cursor: 'pointer' } })}
        columns={[
          { title: 'Topic', dataIndex: 'topic', width: 220, ellipsis: true },
          { title: 'Finding', dataIndex: 'finding', ellipsis: true },
          {
            title: 'Source',
            dataIndex: 'source',
            width: 220,
            ellipsis: true,
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
            render: (v: number | null) => (v == null ? '—' : <Progress percent={Math.round(v * 100)} size="small" />),
          },
          { title: 'Fetched', dataIndex: 'fetched_at', width: 110, render: (v: string) => timeAgo(v) },
        ]}
      />
      <ResearchNoteDialog note={selected} open={selected !== null} onClose={() => setSelected(null)} />
    </>
  )
}
