import { useEffect, useRef, type PointerEvent, type ThHTMLAttributes } from 'react'

interface ResizableTitleProps extends ThHTMLAttributes<HTMLTableCellElement> {
  width?: number
  /** Fires continuously while dragging (at most once per frame) -- live width, not yet persisted. */
  onResize?: (width: number) => void
  /** Fires once when the drag ends, with the final width, so the caller can persist it. */
  onResizeEnd?: (width: number) => void
  /** Fires on double-clicking the handle -- drops the stored width so the column auto-sizes again. */
  onReset?: () => void
}

const MIN_WIDTH = 60

/** A <th> replacement that adds a drag handle on its trailing edge to resize the column. */
export function ResizableTitle({
  width,
  onResize,
  onResizeEnd,
  onReset,
  children,
  style,
  ...rest
}: ResizableTitleProps) {
  const thRef = useRef<HTMLTableCellElement>(null)
  const frame = useRef(0)

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  if (!onResize) {
    return (
      <th style={style} {...rest}>
        {children}
      </th>
    )
  }

  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    // No declared width means this column is still auto-sized to fill space --
    // measure its live rendered width so the drag starts from where it looks, not from 0.
    const startWidth = width ?? thRef.current?.offsetWidth ?? 150
    let latest = startWidth
    e.currentTarget.setPointerCapture(e.pointerId)

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      latest = Math.max(MIN_WIDTH, startWidth + (moveEvent.clientX - startX))
      // Coalesce to one state update per frame -- a raw pointermove stream re-renders every row.
      if (frame.current) return
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        onResize(latest)
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (frame.current) {
        cancelAnimationFrame(frame.current)
        frame.current = 0
      }
      // A click that never moved isn't a resize -- don't churn state or storage for it.
      if (latest !== startWidth) onResizeEnd?.(latest)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <th ref={thRef} style={{ ...style, position: 'relative' }} {...rest}>
      {children}
      <span
        className="col-resize-handle"
        title="Drag to resize, double-click to reset"
        onPointerDown={onPointerDown}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          e.stopPropagation()
          onReset?.()
        }}
      />
    </th>
  )
}
