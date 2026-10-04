import { Fragment, type CSSProperties } from 'react'
import { Typography } from 'antd'
import { parseBlocks, parseInline } from '../markdown'

const { Paragraph, Title } = Typography

// Minimal Markdown rendering for model-authored text. The parser (../markdown.ts) handles
// **bold**, `code`, http(s) links, "## " headings and bullet/numbered lists -- just enough
// structure for the proposal_create, research_note_add and report_submit prompts to target.
// Everything renders as React elements, never as HTML.

function renderInline(text: string, keyPrefix: string) {
  return parseInline(text).map((part, i) => {
    const key = `${keyPrefix}-${i}`
    switch (part.type) {
      case 'bold':
        return <strong key={key}>{part.text}</strong>
      case 'code':
        return (
          <Typography.Text key={key} code>
            {part.text}
          </Typography.Text>
        )
      case 'link':
        return (
          <Typography.Link key={key} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.text}
          </Typography.Link>
        )
      default:
        return <Fragment key={key}>{part.text}</Fragment>
    }
  })
}

export function MarkdownLite({ text, style }: { text: string; style?: CSSProperties }) {
  const blocks = parseBlocks(text ?? '')
  if (blocks.length === 0) return null

  return (
    <div style={style}>
      {blocks.map((block, i) => {
        const last = i === blocks.length - 1
        if (block.type === 'heading') {
          return (
            <Title key={i} level={block.level === 1 ? 4 : 5} style={{ marginTop: i === 0 ? 0 : 16, marginBottom: 8 }}>
              {renderInline(block.text, `${i}`)}
            </Title>
          )
        }
        if (block.type === 'list') {
          const List = block.ordered ? 'ol' : 'ul'
          return (
            <List key={i} style={{ margin: `4px 0 ${last ? 0 : 12}px`, paddingLeft: 20 }}>
              {block.items.map((item, j) => (
                <li key={j} style={{ marginBottom: 4 }}>
                  {renderInline(item, `${i}-${j}`)}
                </li>
              ))}
            </List>
          )
        }
        return (
          <Paragraph key={i} style={{ marginBottom: last ? 0 : 12 }}>
            {renderInline(block.text, `${i}`)}
          </Paragraph>
        )
      })}
    </div>
  )
}
