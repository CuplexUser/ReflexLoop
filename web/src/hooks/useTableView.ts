import { useCallback, useMemo, useState } from 'react'
import type { ColumnsType } from 'antd/es/table'
import { useResizableColumns } from './useResizableColumns'

const STORAGE_PREFIX = 'reflexloop:table-view:'

export type Density = 'small' | 'middle' | 'large'

interface StoredView {
  hiddenColumns?: string[]
  density?: Density
  pageSize?: number
}

function readStored(storageKey: string): StoredView {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + storageKey)
    return raw ? (JSON.parse(raw) as StoredView) : {}
  } catch {
    return {}
  }
}

function writeStored(storageKey: string, view: StoredView): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify(view))
  } catch {
    // storage blocked -- preferences still apply for this session
  }
}

/** Stable identity for a column, independent of its position once others are hidden. */
function columnKey(col: { key?: unknown; dataIndex?: unknown; title?: unknown }, index: number): string {
  return String(col.key ?? col.dataIndex ?? (typeof col.title === 'string' ? col.title : index))
}

/**
 * Everything a table's chrome needs, in one place: resizable+persisted widths (via
 * useResizableColumns), column show/hide, row density, and page size — all remembered per
 * `storageKey` so the view a person set up survives navigation and reloads.
 *
 * Keys are assigned from the *unfiltered* column list, so hiding a column can't shift the
 * identity of the ones after it and silently reassign their stored widths.
 */
export function useTableView<T extends object>(
  storageKey: string,
  baseColumns: ColumnsType<T>,
  options: { defaultPageSize?: number } = {},
) {
  const stored = useMemo(() => readStored(storageKey), [storageKey])
  const [hiddenColumns, setHiddenColumns] = useState<string[]>(stored.hiddenColumns ?? [])
  const [density, setDensityState] = useState<Density>(stored.density ?? 'middle')
  const [pageSize, setPageSizeState] = useState<number>(stored.pageSize ?? options.defaultPageSize ?? 10)

  const persist = useCallback(
    (patch: StoredView) => writeStored(storageKey, { hiddenColumns, density, pageSize, ...patch }),
    [storageKey, hiddenColumns, density, pageSize],
  )

  const keyed = useMemo<ColumnsType<T>>(
    () => baseColumns.map((col, index) => ({ ...col, key: columnKey(col, index) })),
    [baseColumns],
  )

  const allColumns = useMemo(
    () =>
      keyed.map((col) => ({
        key: String(col.key),
        title: typeof col.title === 'string' ? col.title : String(col.key),
      })),
    [keyed],
  )

  const visible = useMemo(
    () => keyed.filter((col) => !hiddenColumns.includes(String(col.key))),
    [keyed, hiddenColumns],
  )

  const { columns, components, scroll } = useResizableColumns<T>(storageKey, visible)

  const toggleColumn = useCallback(
    (key: string, show: boolean) => {
      setHiddenColumns((prev) => {
        const next = show ? prev.filter((k) => k !== key) : [...new Set([...prev, key])]
        persist({ hiddenColumns: next })
        return next
      })
    },
    [persist],
  )

  const showAllColumns = useCallback(() => {
    setHiddenColumns([])
    persist({ hiddenColumns: [] })
  }, [persist])

  const setDensity = useCallback(
    (next: Density) => {
      setDensityState(next)
      persist({ density: next })
    },
    [persist],
  )

  const setPageSize = useCallback(
    (next: number) => {
      setPageSizeState(next)
      persist({ pageSize: next })
    },
    [persist],
  )

  return {
    columns,
    components,
    scroll,
    /** Spread straight onto <Table>. `sticky` keeps the header visible on a long scroll. */
    tableProps: {
      size: density,
      sticky: true,
      pagination: {
        pageSize,
        showSizeChanger: true,
        pageSizeOptions: [10, 20, 50, 100],
        onShowSizeChange: (_current: number, size: number) => setPageSize(size),
        showTotal: (total: number) => `${total} row${total === 1 ? '' : 's'}`,
      },
    },
    /** Feeds TableToolbar. */
    view: { allColumns, hiddenColumns, toggleColumn, showAllColumns, density, setDensity },
  }
}

export type TableViewControls = ReturnType<typeof useTableView>['view']
