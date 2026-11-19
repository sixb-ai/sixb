import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

// Reordering a list by dragging one of its items, as the scenes strip and the phone's list do.
// The press is followed on the window, not on the item: a phone's WebKit drops a capture when the
// list draws again under the finger, and the drop must still land.

/** How far a press moves before it is a drag, not a tap. */
const DRAG_PX = 5

export interface ReorderDrag {
  readonly id: string
  /** The slot it would land in: before the item at this index, or at the end. */
  readonly slot: number
}

export function useReorder({
  items,
  axis,
  onMove,
}: {
  /** The list's items, in order, each marked with its id. */
  readonly items: () => readonly HTMLElement[]
  readonly axis: "x" | "y"
  /** Moves the item to `to`, its index once it has left its place. */
  readonly onMove: (id: string, from: number, to: number) => void
}): {
  readonly drag: ReorderDrag | null
  /** Starts following a press on an item; `onTap` runs when it never became a drag. */
  readonly start: (event: ReactPointerEvent, id: string, onTap?: () => void) => void
} {
  const [drag, setDrag] = useState<ReorderDrag | null>(null)
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])

  const slotAt = useCallback(
    (point: number) => {
      const found = items().findIndex((item) => {
        const box = item.getBoundingClientRect()
        return axis === "x" ? point < box.left + box.width / 2 : point < box.top + box.height / 2
      })
      return found < 0 ? items().length : found
    },
    [items, axis]
  )

  const start = useCallback(
    (event: ReactPointerEvent, id: string, onTap?: () => void) => {
      if (event.button !== 0) return
      stop.current?.()
      const origin = axis === "x" ? event.clientX : event.clientY
      let dragging = false
      let slot = -1

      const move = (moved: PointerEvent) => {
        const point = axis === "x" ? moved.clientX : moved.clientY
        if (!dragging && Math.abs(point - origin) < DRAG_PX) return
        dragging = true
        moved.preventDefault()
        slot = slotAt(point)
        setDrag({ id, slot })
      }
      const end = (ended: PointerEvent) => {
        stop.current?.()
        setDrag(null)
        if (ended.type === "pointercancel") return
        if (!dragging) {
          onTap?.()
          return
        }
        const from = items().findIndex((item) => item.dataset.reorderId === id)
        // A slot past its own place is one less once the item leaves it.
        const to = slot > from ? slot - 1 : slot
        if (from >= 0 && to !== from) onMove(id, from, to)
      }

      window.addEventListener("pointermove", move, { passive: false })
      window.addEventListener("pointerup", end)
      window.addEventListener("pointercancel", end)
      stop.current = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", end)
        window.removeEventListener("pointercancel", end)
        stop.current = null
      }
    },
    [axis, slotAt, items, onMove]
  )

  return { drag, start }
}
