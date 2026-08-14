import { useCallback, useEffect, useState } from 'react'

/** True when focus is somewhere that should receive the keystroke itself rather than the table. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/**
 * j/k (or arrow keys) to move a highlight down/up the rows on screen, Enter to open the
 * highlighted one, and optional a/r to decide it. Deliberately scoped to the rows the caller
 * passes in -- that's the current page of the current filter, so the highlight can never land
 * on something the operator can't see.
 */
export function useTableKeyboardNav<T>({
  rows,
  onOpen,
  onApprove,
  onReject,
  enabled = true,
}: {
  rows: T[]
  onOpen?: (row: T) => void
  onApprove?: (row: T) => void
  onReject?: (row: T) => void
  enabled?: boolean
}) {
  const [focusedIndex, setFocusedIndex] = useState(-1)

  // A shrinking or reordered row set must never leave the highlight pointing past the end.
  useEffect(() => {
    setFocusedIndex((i) => (i >= rows.length ? rows.length - 1 : i))
  }, [rows.length])

  useEffect(() => {
    if (!enabled) return

    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return

      const move = (delta: number) => {
        e.preventDefault()
        setFocusedIndex((i) => {
          if (rows.length === 0) return -1
          const next = i < 0 ? (delta > 0 ? 0 : rows.length - 1) : i + delta
          return Math.max(0, Math.min(rows.length - 1, next))
        })
      }

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          return move(1)
        case 'k':
        case 'ArrowUp':
          return move(-1)
        case 'Enter': {
          const row = rows[focusedIndex]
          if (row && onOpen) {
            e.preventDefault()
            onOpen(row)
          }
          return
        }
        case 'a': {
          const row = rows[focusedIndex]
          if (row && onApprove) {
            e.preventDefault()
            onApprove(row)
          }
          return
        }
        case 'r': {
          const row = rows[focusedIndex]
          if (row && onReject) {
            e.preventDefault()
            onReject(row)
          }
          return
        }
        case 'Escape':
          return setFocusedIndex(-1)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [rows, focusedIndex, onOpen, onApprove, onReject, enabled])

  /** Merge into the table's onRow so the highlighted row is visibly the one keys act on. */
  const rowClassName = useCallback(
    (_row: T, index: number) => (index === focusedIndex ? 'row-keyboard-focus' : ''),
    [focusedIndex],
  )

  return { focusedIndex, setFocusedIndex, rowClassName }
}
