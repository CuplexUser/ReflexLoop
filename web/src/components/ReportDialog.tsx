import { useEffect, useState } from 'react'
import { Alert, Modal, Skeleton, Space, Tag, Typography } from 'antd'
import { Link } from 'react-router-dom'
import type { ReportDetail } from '../types'
import { api } from '../api'
import { markdownPreview } from '../format'
import { ReportView } from './ReportView'

/**
 * One report, opened from the Reports page at /reports/:id. Fetched by id rather than taken
 * from the table row, because list rows carry no body -- the body is the bulk of a report and
 * the table never shows it.
 */
export function ReportDialog({ reportId, onClose }: { reportId: number | null; onClose: () => void }) {
  const [report, setReport] = useState<ReportDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (reportId === null) return
    let cancelled = false
    setReport(null)
    setError(null)
    api
      .report(reportId)
      .then((r) => !cancelled && setReport(r))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [reportId])

  const headline = report?.proposal_description?.split('\n').find((l) => l.trim()) ?? null

  return (
    <Modal
      open={reportId !== null}
      onCancel={onClose}
      footer={null}
      width={820}
      destroyOnClose
      title={
        <Space align="center" size={10} wrap>
          <span>Report #{reportId}</span>
          {report && (
            <Link to={`/proposals/${report.proposal_id}`} style={{ fontSize: 13, fontWeight: 400 }}>
              idea #{report.proposal_id}
            </Link>
          )}
          {report?.goal_title && <Tag>{report.goal_title}</Tag>}
        </Space>
      }
    >
      {error ? (
        <Alert type="error" showIcon message="Could not load this report" description={error} />
      ) : !report ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {headline && (
            <Typography.Text type="secondary">{markdownPreview(headline, 200)}</Typography.Text>
          )}
          <ReportView report={report} />
        </Space>
      )}
    </Modal>
  )
}
