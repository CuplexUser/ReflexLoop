import { useCallback, useMemo, useRef, useState } from 'react'
import type { ColumnsType } from 'antd/es/table'
import { ResizableTitle } from '../components/ResizableTitle'

const STORAGE_PREFIX = 'reflexloop:col-widths:'

/**
 * Width assumed for a column that declares none, when totalling up the table's scroll width.
 * Such a column stays auto-sized in the layout -- this is only the share of horizontal space
 * reserved for it before the table starts scrolling.
 */
const FLEX_COLUMN_WIDTH = 280

type Widths = Record<string, number>

function readStored(storageKey: string): Widths {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + storageKey)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return {}
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      ([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0,
    )
    return Object.fromEntries(entries) as Widths
  } catch {
    return {} // unparseable, or storage blocked (private mode) -- fall back to defaults
  }
}

function writeStored(storageKey: string, widths: Widths): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify(widths))
  } catch {
    // quota or blocked storage -- widths still work for this session, just don't survive a reload
  }
}

/**
 * Makes every column in a Table draggable-resizable by its trailing edge, remembering widths
 * in localStorage under `storageKey`. Also returns the `scroll` the Table needs: a column with
 * `ellipsis` puts rc-table into `table-layout: fixed`, where the table is pinned to its
 * container's width and widening one column steals space from its neighbours until they
 * collapse. Giving the Table an explicit `scroll.x` lets it grow past the container and scroll
 * instead (rc-table sizes it `width: x; min-width: 100%`, so it still fills when there's room).
 */
export function useResizableColumns<T extends object>(storageKey: string, baseColumns: ColumnsType<T>) {
  const [widths, setWidths] = useState<Widths>(() => readStored(storageKey))
  const widthsRef = useRef(widths)

  const commit = useCallback(
    (next: Widths) => {
      widthsRef.current = next
      setWidths(next)
      writeStored(storageKey, next)
    },
    [storageKey],
  )

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
            // Live drag: state only, so a fast pointer stream doesn't hammer localStorage.
            onResize: (next: number) => setWidths((w) => ({ ...w, [key]: next })),
            onResizeEnd: (next: number) => commit({ ...widthsRef.current, [key]: next }),
            onReset: () => {
              const next = { ...widthsRef.current }
              delete next[key]
              commit(next)
            },
          }),
        }
      }),
    [baseColumns, widths, commit],
  )

  const scrollX = useMemo(
    () => columns.reduce((sum, col) => sum + (typeof col.width === 'number' ? col.width : FLEX_COLUMN_WIDTH), 0),
    [columns],
  )

  return {
    columns,
    components: { header: { cell: ResizableTitle } },
    scroll: { x: scrollX },
  }
}
