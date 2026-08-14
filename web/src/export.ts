// web/src/export.ts
//
// Client-side CSV/JSON download of whatever a table is currently showing --
// filters, sort, and search included, since the rows handed in are the rows on
// screen. No server round trip and no extra endpoint: the console already holds
// the data it would export.

function download(filename: string, mimeType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  // Revoking immediately can cancel the download in some browsers; one frame is enough.
  requestAnimationFrame(() => URL.revokeObjectURL(url))
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value)
  // Quote whenever the value could otherwise break the row or column boundary.
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/**
 * `columns` fixes both the column order and which fields are included, so an export matches
 * the table it came from rather than dumping every field the row happens to carry.
 */
export function exportCsv<T extends object>(
  name: string,
  rows: T[],
  columns: { key: keyof T & string; title: string }[],
): void {
  const header = columns.map((c) => csvCell(c.title)).join(',')
  const body = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(',')).join('\n')
  download(`${name}-${timestamp()}.csv`, 'text/csv', `${header}\n${body}`)
}

export function exportJson<T>(name: string, rows: T[]): void {
  download(`${name}-${timestamp()}.json`, 'application/json', JSON.stringify(rows, null, 2))
}
