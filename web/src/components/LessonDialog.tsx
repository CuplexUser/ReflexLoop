import { useEffect, useState } from 'react'
import { Alert, App, Button, Input, Modal, Popconfirm, Progress, Space, Switch, Tag, Typography } from 'antd'
import { DeleteOutlined, EditOutlined } from '@ant-design/icons'
import type { LessonRow } from '../types'
import { api } from '../api'
import { palette } from '../theme'

/**
 * Read view plus the human's curation controls. A lesson steers every future cycle through
 * lesson_search, and the model has no tool to correct or retract one — so editing, muting, and
 * deleting are the operator's only way to stop a wrong lesson compounding.
 */
export function LessonDialog({
  lesson,
  open,
  onClose,
  onChanged,
}: {
  lesson: LessonRow | null
  open: boolean
  onClose: () => void
  onChanged?: () => void
}) {
  const { message } = App.useApp()
  const [editing, setEditing] = useState(false)
  const [domain, setDomain] = useState('')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [muting, setMuting] = useState(false)

  useEffect(() => {
    if (!lesson) return
    setEditing(false)
    setDomain(lesson.domain)
    setText(lesson.lesson)
  }, [lesson])

  if (!lesson) return null

  async function save() {
    if (!lesson) return
    setSaving(true)
    try {
      await api.editLesson(lesson.id, { domain: domain.trim(), lesson: text.trim() })
      message.success(`Lesson #${lesson.id} updated`)
      setEditing(false)
      onChanged?.()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setSaving(false)
    }
  }

  async function toggleMute(muted: boolean) {
    if (!lesson) return
    setMuting(true)
    try {
      await api.muteLesson(lesson.id, muted)
      message.success(muted ? 'Muted — the agent will stop retrieving this' : 'Unmuted')
      onChanged?.()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Mute failed')
    } finally {
      setMuting(false)
    }
  }

  async function remove() {
    if (!lesson) return
    try {
      await api.deleteLesson(lesson.id)
      message.success(`Lesson #${lesson.id} deleted`)
      onChanged?.()
      onClose()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const dirty = domain.trim() !== lesson.domain || text.trim() !== lesson.lesson

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      title={
        <Space align="center" size={10} wrap>
          <span>Lesson #{lesson.id}</span>
          <Tag color="default">{lesson.domain}</Tag>
          {lesson.muted === 1 && <Tag color="warning">muted</Tag>}
          {lesson.edited_at && <Tag color="blue">edited by human</Tag>}
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {lesson.muted === 1 && (
          <Alert
            type="warning"
            showIcon
            message="Muted"
            description="Excluded from lesson_search, so it no longer influences research, planning, or reflection. The record is kept."
          />
        )}

        {editing ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                DOMAIN
              </Typography.Text>
              <Input value={domain} onChange={(e) => setDomain(e.target.value)} style={{ marginTop: 4 }} />
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                LESSON
              </Typography.Text>
              <Input.TextArea
                value={text}
                onChange={(e) => setText(e.target.value)}
                autoSize={{ minRows: 3, maxRows: 10 }}
                style={{ marginTop: 4 }}
              />
            </div>
            <Space>
              <Button type="primary" loading={saving} disabled={!dirty || !domain.trim() || !text.trim()} onClick={save}>
                Save
              </Button>
              <Button
                onClick={() => {
                  setEditing(false)
                  setDomain(lesson.domain)
                  setText(lesson.lesson)
                }}
              >
                Cancel
              </Button>
            </Space>
          </Space>
        ) : (
          <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{lesson.lesson}</Typography.Paragraph>
        )}

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

        <Space size={24} wrap>
          <Tag color="success">Reinforced +{lesson.times_reinforced}</Tag>
          <Tag color="error">Contradicted -{lesson.times_contradicted}</Tag>
        </Space>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Created {new Date(lesson.created_at).toLocaleString()} · Updated{' '}
          {new Date(lesson.updated_at).toLocaleString()}
          {lesson.derived_from_outcome_id != null && <> · Derived from outcome #{lesson.derived_from_outcome_id}</>}
        </Typography.Text>

        <Space size={16} wrap style={{ borderTop: `1px solid ${palette.border}`, paddingTop: 12, width: '100%' }}>
          {!editing && (
            <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          <Space size={8}>
            <Switch checked={lesson.muted === 1} loading={muting} onChange={toggleMute} />
            <Typography.Text>Mute (hide from the agent)</Typography.Text>
          </Space>
          <Popconfirm
            title="Delete this lesson?"
            description="Permanent. Mute instead if you only want the agent to stop using it."
            okButtonProps={{ danger: true }}
            onConfirm={remove}
          >
            <Button danger ghost icon={<DeleteOutlined />}>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      </Space>
    </Modal>
  )
}
