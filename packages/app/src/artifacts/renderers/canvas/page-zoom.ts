import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { clampZoom, fitScale, type PageSize, type Room, zoomStep } from "./page-size"

/** How an opened board is zoomed: fitted, as it opens or whole, or at a zoom the reader chose. */
type Zoom = { readonly fit: "open" | "whole" } | { readonly scale: number }

const OPEN: Zoom = { fit: "open" }

/** How long the page takes to glide back to the middle once a resize ends. */
const SETTLE_MS = 220

/** A point on the page, in its own pixels. */
export interface PagePoint {
  readonly x: number
  readonly y: number
}

/** Where the page sits in the stage that scrolls over it, and how large that stage's content is. */
export interface PagePlacement {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * Where the page sits: centered while it fits the view, else from the padding, the content as
 * large as it takes. `held`, its top left stays where a resize found it.
 */
export function pagePlacement(
  view: Room,
  box: Room,
  pad: StagePadding,
  held: { readonly left: number; readonly top: number } | null = null
): PagePlacement {
  const left = held?.left ?? Math.max(pad.side, (view.width - box.width) / 2)
  const top =
    held?.top ?? Math.max(pad.top, pad.top + (view.height - pad.top - pad.bottom - box.height) / 2)
  return {
    left,
    top,
    width: Math.max(view.width, left + box.width + pad.side),
    height: Math.max(view.height, top + box.height + pad.bottom),
  }
}

/** The room kept around the page. */
export interface StagePadding {
  readonly side: number
  readonly top: number
  readonly bottom: number
}

/**
 * The room kept around the page: less on a phone, where its foot stays clear of the zoom bar,
 * which would cover its bottom handle.
 */
export function stagePadding(view: Room): StagePadding {
  return view.width < 640 ? { side: 12, top: 12, bottom: 64 } : { side: 24, top: 24, bottom: 24 }
}

/**
 * An opened board's zoom, and where its page sits in the stage scrolled over it. It opens fitted
 * as {@link fitScale} says, and stays fitted as the room changes, until the reader zooms. A zoom
 * keeps the point it is made around where it was on screen: the pointer's, or the view's middle.
 * Each board opens fitted again.
 */
export function usePageZoom({
  id,
  page,
  view,
  stage,
}: {
  /** The board shown: another opens fitted. */
  readonly id: string
  readonly page: PageSize
  /** The stage's size on screen, once measured. */
  readonly view: Room | null
  /** The element that scrolls over the page. */
  readonly stage: HTMLElement | null
}) {
  const [state, setState] = useState<{ readonly id: string; readonly zoom: Zoom }>({
    id,
    zoom: OPEN,
  })
  const zoom = state.id === id ? state.zoom : OPEN
  const [held, setHeld] = useState<{ readonly left: number; readonly top: number } | null>(null)
  // A resize just ended: the page glides back to the middle rather than jumping there.
  const [settling, setSettling] = useState(false)

  const pad = view ? stagePadding(view) : null
  const room =
    view && pad
      ? {
          width: Math.max(1, view.width - pad.side * 2),
          height: Math.max(1, view.height - pad.top - pad.bottom),
        }
      : null
  const scale = !room ? 0 : "scale" in zoom ? zoom.scale : fitScale(page, room, zoom.fit)
  const box = { width: page.w * scale, height: page.h * scale }
  const placement = view && pad ? pagePlacement(view, box, pad, held) : null

  // A zoom made and not drawn yet: the page point it is made around, and where on the view that
  // point stays. Zooms made before it is drawn, as a pinch's are, go on from it.
  const anchor = useRef<{ x: number; y: number; vx: number; vy: number; scale: number } | null>(
    null
  )
  const latest = useRef({ id, scale, placement, view })
  latest.current = { id, scale, placement, view }

  useLayoutEffect(() => {
    const point = anchor.current
    if (!point || !stage || !placement) return

    anchor.current = null
    stage.scrollLeft = placement.left + point.x * scale - point.vx
    stage.scrollTop = placement.top + point.y * scale - point.vy
  }, [stage, placement, scale])

  // Another board, or a fit, starts at the page's top.
  const fitted = "fit" in zoom ? zoom.fit : null
  // biome-ignore lint/correctness/useExhaustiveDependencies: another board is one more start.
  useLayoutEffect(() => {
    if (fitted === null || !stage) return
    stage.scrollTop = 0
    stage.scrollLeft = 0
  }, [stage, fitted, id])

  /** Zooms to `next`, around a point of the page, or the view's middle. */
  const zoomTo = useCallback(
    (next: number, at: PagePoint | null = null) => {
      const { id, scale, placement, view } = latest.current
      if (!stage || !placement || !view || scale === 0) return

      const pending = anchor.current
      const from = pending?.scale ?? scale
      const target = clampZoom(next)
      if (Math.abs(target - from) < 1e-4) return

      if (!pending) {
        const vx = at ? placement.left + at.x * scale - stage.scrollLeft : view.width / 2
        const vy = at ? placement.top + at.y * scale - stage.scrollTop : view.height / 2
        anchor.current = {
          x: (stage.scrollLeft + vx - placement.left) / scale,
          y: (stage.scrollTop + vy - placement.top) / scale,
          vx,
          vy,
          scale: target,
        }
      } else {
        anchor.current = { ...pending, scale: target }
      }
      setState({ id, zoom: { scale: target } })
    },
    [stage]
  )

  /** The zoom now, counting one made and not drawn yet. */
  const current = useCallback(() => anchor.current?.scale ?? latest.current.scale, [])

  const zoomBy = useCallback(
    (factor: number, at: PagePoint | null = null) => zoomTo(current() * factor, at),
    [zoomTo, current]
  )
  const step = useCallback(
    (direction: "in" | "out") => zoomTo(zoomStep(current(), direction)),
    [zoomTo, current]
  )
  const fit = useCallback((how: "open" | "whole" = "whole") => {
    anchor.current = null
    setState({ id: latest.current.id, zoom: { fit: how } })
  }, [])

  /** A double-click: the page at its own size around the pointer, or, at it, the whole page. */
  const toggle = useCallback(
    (at: PagePoint) => {
      if (Math.abs(current() - 1) < 0.01) fit("whole")
      else zoomTo(1, at)
    },
    [fit, zoomTo, current]
  )

  /** A point on screen as a point of the page. */
  const pageAt = useCallback(
    (clientX: number, clientY: number): PagePoint | null => {
      const { scale, placement } = latest.current
      if (!stage || !placement || scale === 0) return null

      const rect = stage.getBoundingClientRect()
      return {
        x: (stage.scrollLeft + clientX - rect.left - placement.left) / scale,
        y: (stage.scrollTop + clientY - rect.top - placement.top) / scale,
      }
    },
    [stage]
  )

  /** A resize starts: the zoom, and the page's top left, stay as they are until it ends. */
  const hold = useCallback(() => {
    const { id, scale, placement } = latest.current
    if (!placement) return
    setState({ id, zoom: { scale } })
    setHeld({ left: placement.left, top: placement.top })
  }, [])
  const release = useCallback(() => {
    setHeld(null)
    setSettling(true)
  }, [])

  useEffect(() => {
    if (!settling) return
    const timer = window.setTimeout(() => setSettling(false), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [settling])

  // ⌘ or Ctrl with the wheel, or a trackpad's pinch, over the stage around the page zooms it, as
  // the frame says the reader does over the page itself; two fingers pinch on a touch screen.
  useEffect(() => {
    if (!stage) return
    const mac = /Mac|iPhone|iPad/.test(navigator.platform)

    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()

      const unit = event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002
      const factor = 2 ** (-event.deltaY * unit * (event.ctrlKey && mac ? 10 : 1))
      zoomBy(factor, pageAt(event.clientX, event.clientY))
    }

    let spread = 0
    const spreadOf = (touches: TouchList) => {
      const [one, two] = [touches[0], touches[1]]
      return one && two ? Math.hypot(one.clientX - two.clientX, one.clientY - two.clientY) : 0
    }
    const onTouchStart = (event: TouchEvent) => {
      spread = event.touches.length === 2 ? spreadOf(event.touches) : 0
    }
    const onTouchMove = (event: TouchEvent) => {
      const [one, two] = [event.touches[0], event.touches[1]]
      if (!one || !two || event.touches.length !== 2 || spread === 0) return
      event.preventDefault()

      const next = spreadOf(event.touches)
      zoomBy(
        next / spread,
        pageAt((one.clientX + two.clientX) / 2, (one.clientY + two.clientY) / 2)
      )
      spread = next
    }

    stage.addEventListener("wheel", onWheel, { passive: false })
    stage.addEventListener("touchstart", onTouchStart, { passive: true })
    stage.addEventListener("touchmove", onTouchMove, { passive: false })
    return () => {
      stage.removeEventListener("wheel", onWheel)
      stage.removeEventListener("touchstart", onTouchStart)
      stage.removeEventListener("touchmove", onTouchMove)
    }
  }, [stage, zoomBy, pageAt])

  return {
    scale,
    placement,
    /** Whether a resize holds the page where it is. */
    held: held !== null,
    /** Whether the page glides back to where it sits, as a resize ends. */
    settling,
    zoomTo,
    zoomBy,
    step,
    fit,
    toggle,
    pageAt,
    hold,
    release,
  }
}

export type PageZoom = ReturnType<typeof usePageZoom>
