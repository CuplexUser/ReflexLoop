import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Input, Progress, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd'
import type { LessonRow } from '../types'
import { api } from '../api'
import { timeAgo } from '../format'
import { palette } from '../theme'
import { LessonDialog } from '../components/LessonDialog'
import { TableToolbar } from '../components/TableToolbar'
import { useTableView } from '../hooks/useTableView'
import { useTableKeyboardNav } from '../hooks/useTableKeyboardNav'
import { exportCsv, exportJson } from '../export'

export function LessonsPage({ historyVersion }: { historyVersion: number }) {
  const navigate = useNavigate()
  const { id } = useParams()
  const [lessons, setLessons] = useState<LessonRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showMuted, setShowMuted] = useState(true)
  // Bumped locally after a curation edit, so the table refetches without waiting on an agent event.
  const [localVersion, setLocalVersion] = useState(0)

  useEffect(() => {
    api
      .lessons()
      .then(setLessons)
      .finally(() => setLoading(false))
  }, [historyVersion, localVersion])

  const selected = id ? (lessons.find((l) => l.id === Number(id)) ?? null) : null
  const openLesson = useCallback((l: LessonRow) => navigate(`/lessons/${l.id}`), [navigate])
  const closeLesson = useCallback(() => navigate('/lessons'), [navigate])

  const domainFilters = useMemo(
    () => [...new Set(lessons.map((l) => l.domain))].sort().map((d) => ({ text: d, value: d })),
    [lessons],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return lessons.filter((l) => {
      if (!showMuted && l.muted === 1) return false
      return !q || `${l.domain} ${l.lesson}`.toLowerCase().includes(q)
    })
  }, [lessons, search, showMuted])

  const { rowClassName } = useTableKeyboardNav<LessonRow>({
    rows: filtered,
    onOpen: openLesson,
    enabled: selected === null,
  })

  const baseColumns = useMemo(
    () => [
      {
        title: 'Domain',
        dataIndex: 'domain',
        width: 200,
        ellipsis: true,
        sorter: (a: LessonRow, b: LessonRow) => a.domain.localeCompare(b.domain),
        filters: domainFilters,
        onFilter: (value: unknown, record: LessonRow) => record.domain === value,
      },
      {
        title: 'Lesson',
        dataIndex: 'lesson',
        ellipsis: true,
        sorter: (a: LessonRow, b: LessonRow) => a.lesson.localeCompare(b.lesson),
        render: (v: string, l: LessonRow) => (
          <span style={{ opacity: l.muted === 1 ? 0.45 : 1 }}>
            {l.muted === 1 && (
              <Tag color="warning" style={{ marginRight: 6 }}>
                muted
              </Tag>
            )}
            {v}
          </span>
        ),
      },
      {
        title: 'Confidence',
        dataIndex: 'confidence',
        width: 160,
        sorter: (a: LessonRow, b: LessonRow) => a.confidence - b.confidence,
        render: (v: number) => (
          <Progress percent={Math.round(v * 100)} size="small" strokeColor={v >= 0.5 ? palette.approved : palette.rejected} />
        ),
      },
      {
        title: 'Track record',
        width: 150,
        sorter: (a: LessonRow, b: LessonRow) =>
          a.times_reinforced - a.times_contradicted - (b.times_reinforced - b.times_contradicted),
        render: (_: unknown, l: LessonRow) => (
          <>
            <Tag color="success">+{l.times_reinforced}</Tag>
            <Tag color="error">-{l.times_contradicted}</Tag>
          </>
        ),
      },
      {
        title: 'Updated',
        dataIndex: 'updated_at',
        width: 120,
        sorter: (a: LessonRow, b: LessonRow) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime(),
        defaultSortOrder: 'descend' as const,
        render: (v: string, l: LessonRow) => (
          <Tooltip title={new Date(v).toLocaleString()}>
            <span>
              {timeAgo(v)}
              {l.edited_at && ' ✎'}
            </span>
          </Tooltip>
        ),
      },
    ],
    [domainFilters],
  )

  const { columns, components, scroll, tableProps, view } = useTableView<LessonRow>('lessons', baseColumns)

  const mutedCount = lessons.filter((l) => l.muted === 1).length

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space size={12} wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Space size={16} wrap>
          <Input.Search
            allowClear
            placeholder="Search domain or lesson…"
            style={{ width: 320 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {mutedCount > 0 && (
            <Space size={8}>
              <Switch checked={showMuted} onChange={setShowMuted} size="small" />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Show {mutedCount} muted
              </Typography.Text>
            </Space>
          )}
        </Space>
        <TableToolbar
          view={view}
          onExportCsv={() =>
            exportCsv('lessons', filtered, [
              { key: 'id', title: '#' },
              { key: 'domain', title: 'Domain' },
              { key: 'lesson', title: 'Lesson' },
              { key: 'confidence', title: 'Confidence' },
              { key: 'times_reinforced', title: 'Reinforced' },
              { key: 'times_contradicted', title: 'Contradicted' },
              { key: 'muted', title: 'Muted' },
              { key: 'updated_at', title: 'Updated' },
            ])
          }
          onExportJson={() => exportJson('lessons', filtered)}
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
        onRow={(l) => ({ onClick: () => openLesson(l), style: { cursor: 'pointer' } })}
        {...tableProps}
      />

      <LessonDialog
        lesson={selected}
        open={selected !== null}
        onClose={closeLesson}
        onChanged={() => setLocalVersion((v) => v + 1)}
      />
    </Space>
  )
}
