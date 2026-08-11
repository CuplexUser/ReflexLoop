import { useEffect, useState } from 'react'
import { Progress, Table, Tag } from 'antd'
import type { LessonRow } from '../types'
import { api } from '../api'
import { timeAgo } from '../format'
import { palette } from '../theme'
import { LessonDialog } from '../components/LessonDialog'

export function LessonsPage({ historyVersion }: { historyVersion: number }) {
  const [lessons, setLessons] = useState<LessonRow[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<LessonRow | null>(null)

  useEffect(() => {
    api
      .lessons()
      .then(setLessons)
      .finally(() => setLoading(false))
  }, [historyVersion])

  return (
    <>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={lessons}
        pagination={{ pageSize: 10 }}
        onRow={(l) => ({ onClick: () => setSelected(l), style: { cursor: 'pointer' } })}
        columns={[
          { title: 'Domain', dataIndex: 'domain', width: 200, ellipsis: true },
          { title: 'Lesson', dataIndex: 'lesson', ellipsis: true },
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
            render: (_, l) => (
              <>
                <Tag color="success">+{l.times_reinforced}</Tag>
                <Tag color="error">-{l.times_contradicted}</Tag>
              </>
            ),
          },
          { title: 'Updated', dataIndex: 'updated_at', width: 110, render: (v: string) => timeAgo(v) },
        ]}
      />
      <LessonDialog lesson={selected} open={selected !== null} onClose={() => setSelected(null)} />
    </>
  )
}
