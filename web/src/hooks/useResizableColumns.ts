import { useMemo, useState } from 'react'
import type { ColumnsType } from 'antd/es/table'
import { ResizableTitle } from '../components/ResizableTitle'

/** Makes every column in a Table draggable-resizable by its trailing edge, remembering widths in state. */
export function useResizableColumns<T extends object>(baseColumns: ColumnsType<T>) {
  const [widths, setWidths] = useState<Record<string, number>>({})

  const columns = useMemo<ColumnsType<T>>(
    () =>
      baseColumns.map((col, index) => {
        const key = String(col.key ?? (col as { dataIndex?: string }).dataIndex ?? index)
        // Undeclared width (e.g. the free-text column) stays unset until the user drags it,
        // so it keeps auto-filling remaining space + ellipsis-truncating like a plain column.
        const width = widths[key] ?? (typeof col.width === 'number' ? col.width : undefined)
        return {
          ...col,
          key,
          ...(width !== undefined ? { width } : {}),
          onHeaderCell: () => ({
            width,
            onResize: (next: number) => setWidths((w) => ({ ...w, [key]: next })),
          }),
        }
      }),
    [baseColumns, widths],
  )

  return {
    columns,
    components: { header: { cell: ResizableTitle } },
  }
}
