import { useRef, type PointerEvent, type ThHTMLAttributes } from 'react'

interface ResizableTitleProps extends ThHTMLAttributes<HTMLTableCellElement> {
  width?: number
  onResize?: (width: number) => void
}

const MIN_WIDTH = 60

/** A <th> replacement that adds a drag handle on its trailing edge to resize the column. */
export function ResizableTitle({ width, onResize, children, style, ...rest }: ResizableTitleProps) {
  const thRef = useRef<HTMLTableCellElement>(null)
  const startX = useRef(0)
  const startWidth = useRef(0)

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
    startX.current = e.clientX
    // No declared width means this column is still auto-sized to fill space --
    // measure its live rendered width so the drag starts from where it looks, not from 0.
    startWidth.current = width ?? thRef.current?.offsetWidth ?? 150
    e.currentTarget.setPointerCapture(e.pointerId)

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const next = Math.max(MIN_WIDTH, startWidth.current + (moveEvent.clientX - startX.current))
      onResize(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <th ref={thRef} style={{ ...style, position: 'relative' }} {...rest}>
      {children}
      <span className="col-resize-handle" onPointerDown={onPointerDown} onClick={(e) => e.stopPropagation()} />
    </th>
  )
}
