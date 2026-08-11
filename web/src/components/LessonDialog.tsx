import { Modal, Progress, Space, Tag, Typography } from 'antd'
import type { LessonRow } from '../types'
import { palette } from '../theme'

export function LessonDialog({ lesson, open, onClose }: { lesson: LessonRow | null; open: boolean; onClose: () => void }) {
  if (!lesson) return null

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      title={
        <Space align="center" size={10}>
          <span>Lesson #{lesson.id}</span>
          <Tag color="default">{lesson.domain}</Tag>
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{lesson.lesson}</Typography.Paragraph>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            CONFIDENCE
          </Typography.Text>
          <Progress
            percent={Math.round(lesson.confidence * 100)}
            strokeColor={lesson.confidence >= 0.5 ? palette.approved : palette.rejected}
            style={{ marginTop: 4, maxWidth: 320 }}
          />
        </div>

        <Space size={24}>
          <Tag color="success">Reinforced +{lesson.times_reinforced}</Tag>
          <Tag color="error">Contradicted -{lesson.times_contradicted}</Tag>
        </Space>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Created {new Date(lesson.created_at).toLocaleString()} · Updated{' '}
          {new Date(lesson.updated_at).toLocaleString()}
          {lesson.derived_from_outcome_id != null && <> · Derived from outcome #{lesson.derived_from_outcome_id}</>}
        </Typography.Text>
      </Space>
    </Modal>
  )
}
