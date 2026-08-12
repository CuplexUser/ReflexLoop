import { useEffect, useMemo, useState } from 'react'
import { Input, Progress, Space, Table, Tag } from 'antd'
import type { LessonRow } from '../types'
import { api } from '../api'
import { timeAgo } from '../format'
import { palette } from '../theme'
import { LessonDialog } from '../components/LessonDialog'
import { useResizableColumns } from '../hooks/useResizableColumns'

export function LessonsPage({ historyVersion }: { historyVersion: number }) {
  const [lessons, setLessons] = useState<LessonRow[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<LessonRow | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    api
      .lessons()
      .then(setLessons)
      .finally(() => setLoading(false))
  }, [historyVersion])

  const domainFilters = useMemo(
    () => [...new Set(lessons.map((l) => l.domain))].sort().map((d) => ({ text: d, value: d })),
    [lessons],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return lessons
    return lessons.filter((l) => `${l.domain} ${l.lesson}`.toLowerCase().includes(q))
  }, [lessons, search])

  const { columns, components } = useResizableColumns<LessonRow>([
    {
      title: 'Domain',
      dataIndex: 'domain',
      width: 200,
      ellipsis: true,
      sorter: (a, b) => a.domain.localeCompare(b.domain),
      filters: domainFilters,
      onFilter: (value, record) => record.domain === value,
    },
    {
      title: 'Lesson',
      dataIndex: 'lesson',
      ellipsis: true,
      sorter: (a, b) => a.lesson.localeCompare(b.lesson),
    },
    {
      title: 'Confidence',
      dataIndex: 'confidence',
      width: 160,
      sorter: (a, b) => a.confidence - b.confidence,
      render: (v: number) => (
        <Progress
          percent={Math.round(v * 100)}
          size="small"
          strokeColor={v >= 0.5 ? palette.approved : palette.rejected}
        />
      ),
    },
    {
      title: 'Track record',
      width: 150,
      sorter: (a, b) => a.times_reinforced - a.times_contradicted - (b.times_reinforced - b.times_contradicted),
      render: (_, l) => (
        <>
          <Tag color="success">+{l.times_reinforced}</Tag>
          <Tag color="error">-{l.times_contradicted}</Tag>
        </>
      ),
    },
    {
      title: 'Updated',
      dataIndex: 'updated_at',
      width: 110,
      sorter: (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime(),
      defaultSortOrder: 'descend',
      render: (v: string) => timeAgo(v),
    },
  ])

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Input.Search
        allowClear
        placeholder="Search domain or lesson…"
        style={{ maxWidth: 360 }}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div style={{ overflowX: 'auto' }}>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={filtered}
          pagination={{ pageSize: 10 }}
          components={components}
          onRow={(l) => ({ onClick: () => setSelected(l), style: { cursor: 'pointer' } })}
          columns={columns}
        />
      </div>
      <LessonDialog lesson={selected} open={selected !== null} onClose={() => setSelected(null)} />
    </Space>
  )
}
