// web/src/markdown.ts
//
// The parsing half of MarkdownLite, kept out of the component file so that file exports only
// components (oxlint's fast-refresh rule).
//
// Deliberately not a full Markdown parser: just the subset the agent's prompts ask for. Ideas
// and notes use **bold** and "- " bullets; deep-dive reports add "## " headings, numbered lists
// and [text](url) citations. Anything else (tables, italics, images, raw HTML) stays literal
// text, and nothing here ever produces HTML -- the component renders these tokens as React
// elements, so model-written text cannot inject markup.

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string }

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }

const BULLET = /^[-*]\s+/
const ORDERED = /^\d+[.)]\s+/
const HEADING = /^(#{1,3})\s+(.*)$/

/**
 * Line-oriented, because reports put a heading directly above its list with no blank line in
 * between. A blank line still ends a paragraph or a list.
 */
export function parseBlocks(text: string): Block[] {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: 'paragraph', text: paragraph.join(' ') })
    if (list) blocks.push({ type: 'list', ...list })
    paragraph = []
    list = null
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({ type: 'heading', level: heading[1].length as 1 | 2 | 3, text: heading[2].trim() })
      continue
    }
    const ordered = ORDERED.test(line)
    if (ordered || BULLET.test(line)) {
      if (paragraph.length > 0 || (list && list.ordered !== ordered)) flush()
      list ??= { ordered, items: [] }
      list.items.push(line.replace(ordered ? ORDERED : BULLET, ''))
      continue
    }
    // A wrapped continuation of the previous bullet rather than a new paragraph.
    if (list && /^\s+/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line}`
      continue
    }
    if (list) flush()
    paragraph.push(line)
  }
  flush()
  return blocks
}

// Order matters: a [text](url) link has to be tried before a bare URL, or the URL inside it
// would be matched on its own and the brackets left behind as text.
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g
const LINK = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/

/** Splits a line into text, bold, code and links. Only http(s) URLs ever become links. */
export function parseInline(text: string): Inline[] {
  return text
    .split(INLINE)
    .filter((part) => part.length > 0)
    .map((part): Inline => {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return { type: 'bold', text: part.slice(2, -2) }
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return { type: 'code', text: part.slice(1, -1) }
      const link = LINK.exec(part)
      if (link) return { type: 'link', text: link[1], href: link[2] }
      if (/^https?:\/\//.test(part)) return { type: 'link', text: part, href: part }
      return { type: 'text', text: part }
    })
}
