import { Modal, Progress, Space, Typography } from 'antd'
import type { ResearchNoteRow } from '../types'

export function ResearchNoteDialog({
  note,
  open,
  onClose,
}: {
  note: ResearchNoteRow | null
  open: boolean
  onClose: () => void
}) {
  if (!note) return null

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={640} title={`Research note #${note.id} — ${note.topic}`}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{note.finding}</Typography.Paragraph>

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
      </Space>
    </Modal>
  )
}
