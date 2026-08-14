import { App, Button, Modal, Popconfirm, Progress, Space, Typography } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import type { ResearchNoteRow } from '../types'
import { api } from '../api'
import { palette } from '../theme'
import { MarkdownLite } from './MarkdownLite'

export function ResearchNoteDialog({
  note,
  open,
  onClose,
  onChanged,
}: {
  note: ResearchNoteRow | null
  open: boolean
  onClose: () => void
  onChanged?: () => void
}) {
  const { message } = App.useApp()
  if (!note) return null

  async function remove() {
    if (!note) return
    try {
      await api.deleteResearchNote(note.id)
      message.success(`Research note #${note.id} deleted`)
      onChanged?.()
      onClose()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={640} title={`Research note #${note.id} — ${note.topic}`}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <MarkdownLite text={note.finding} />

        {note.source && (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              SOURCE
            </Typography.Text>
            <div style={{ marginTop: 4 }}>
              <a href={note.source} target="_blank" rel="noreferrer">
                {note.source}
              </a>
            </div>
          </div>
        )}

        {note.confidence != null && (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              CONFIDENCE
            </Typography.Text>
            <Progress percent={Math.round(note.confidence * 100)} style={{ marginTop: 4, maxWidth: 320 }} />
          </div>
        )}

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Fetched {new Date(note.fetched_at).toLocaleString()}
        </Typography.Text>

        <div style={{ borderTop: `1px solid ${palette.border}`, paddingTop: 12 }}>
          <Popconfirm
            title="Delete this research note?"
            description="Permanent, and removes it from the agent's semantic search."
            okButtonProps={{ danger: true }}
            onConfirm={remove}
          >
            <Button danger ghost icon={<DeleteOutlined />}>
              Delete
            </Button>
          </Popconfirm>
        </div>
      </Space>
    </Modal>
  )
}
