import { Fragment, type CSSProperties } from 'react'
import { Typography } from 'antd'

const { Paragraph } = Typography

// Minimal Markdown rendering for model-authored text: **bold** inline, and
// "- "/"* " bullet lists, separated into paragraph/list blocks by blank
// lines. Anything else (headings, links, italics) is left as literal text --
// deliberately not a full Markdown parser, just enough structure for the
// proposal_create/research_note_add prompts to target.

function renderInline(text: string, keyPrefix: string) {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter((part) => part.length > 0)
    .map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>
      ) : (
        <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>
      )
    )
}

type Block = { type: 'paragraph'; text: string } | { type: 'list'; items: string[] }

function parseBlocks(text: string): Block[] {
  const rawBlocks = text.trim().replace(/\r\n/g, '\n').split(/\n{2,}/)
  const blocks: Block[] = []
  for (const raw of rawBlocks) {
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0) continue
    if (lines.every((l) => /^[-*]\s+/.test(l))) {
      blocks.push({ type: 'list', items: lines.map((l) => l.replace(/^[-*]\s+/, '')) })
    } else {
      blocks.push({ type: 'paragraph', text: lines.join(' ') })
    }
  }
  return blocks
}

export function MarkdownLite({ text, style }: { text: string; style?: CSSProperties }) {
  const blocks = parseBlocks(text ?? '')
  if (blocks.length === 0) return null

  return (
    <div style={style}>
      {blocks.map((block, i) => {
        const last = i === blocks.length - 1
        return block.type === 'list' ? (
          <ul key={i} style={{ margin: `4px 0 ${last ? 0 : 12}px`, paddingLeft: 20 }}>
            {block.items.map((item, j) => (
              <li key={j} style={{ marginBottom: 4 }}>
                {renderInline(item, `${i}-${j}`)}
              </li>
            ))}
          </ul>
        ) : (
          <Paragraph key={i} style={{ marginBottom: last ? 0 : 12 }}>
            {renderInline(block.text, `${i}`)}
          </Paragraph>
        )
      })}
    </div>
  )
}
