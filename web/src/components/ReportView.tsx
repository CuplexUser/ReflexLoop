import { Space, Tag, Typography } from 'antd'
import type { ReportRow } from '../types'
import { CONFIDENCE_TAG, VERDICT_LABEL, VERDICT_TAG, scoreTag } from '../report'
import { timeAgo } from '../format'
import { MarkdownLite } from './MarkdownLite'

/**
 * One deep-dive report: the verdict first, then the summary, the full body and every source.
 * Shared by the Reports page dialog and the idea dialog so a report reads the same wherever
 * it is opened.
 */
export function ReportView({ report }: { report: Pick<ReportRow, 'verdict' | 'viability_score' | 'confidence' | 'summary' | 'body' | 'sources' | 'created_at'> }) {
  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space size={6} wrap>
        <Tag color={VERDICT_TAG[report.verdict]} style={{ fontWeight: 600 }}>
          {VERDICT_LABEL[report.verdict]}
        </Tag>
        <Tag color={scoreTag(report.viability_score)}>viability {report.viability_score}/5</Tag>
        <Tag color={CONFIDENCE_TAG[report.confidence]}>{report.confidence} confidence</Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {timeAgo(report.created_at)}
        </Typography.Text>
      </Space>

      <Typography.Paragraph strong style={{ marginBottom: 0 }}>
        {report.summary}
      </Typography.Paragraph>

      <MarkdownLite text={report.body} />

      {report.sources.length > 0 && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            SOURCES
          </Typography.Text>
          <ol style={{ margin: '6px 0 0', paddingLeft: 22 }}>
            {report.sources.map((s, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                <Typography.Link href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title}
                </Typography.Link>
                {s.note && <Typography.Text type="secondary"> — {s.note}</Typography.Text>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Space>
  )
}
