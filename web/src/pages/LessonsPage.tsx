import { useEffect, useState } from 'react'
import { Progress, Table, Tag, Typography } from 'antd'
import type { LessonRow } from '../types'
import { api } from '../api'
import { timeAgo } from '../format'
import { palette } from '../theme'

export function LessonsPage({ historyVersion }: { historyVersion: number }) {
  const [lessons, setLessons] = useState<LessonRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .lessons()
      .then(setLessons)
      .finally(() => setLoading(false))
  }, [historyVersion])

  return (
    <Table
      rowKey="id"
      loading={loading}
      dataSource={lessons}
      pagination={{ pageSize: 10 }}
      columns={[
        { title: 'Domain', dataIndex: 'domain', width: 200, ellipsis: true },
        {
          title: 'Lesson',
          dataIndex: 'lesson',
          render: (v: string) => <Typography.Text ellipsis={{ tooltip: v }}>{v}</Typography.Text>,
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
  )
}
