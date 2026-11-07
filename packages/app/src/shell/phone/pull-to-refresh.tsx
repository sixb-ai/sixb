import { isIOS, PHONE_QUERY } from "@sixb/ui/components"
import { useQueryClient } from "@tanstack/react-query"
import { type CSSProperties, useEffect, useRef } from "react"
import { appScroller } from "./routes"

// How far the page travels, after resistance, before a release refreshes, and where it rests
// while the refresh runs.
const TRIGGER = 72
const REST = 56
const MAX_PULL = 140
const MIN_SPIN_MS = 650
const TICKS = 8
const SETTLE = "transform 380ms cubic-bezier(0.32, 0.72, 0, 1), opacity 240ms ease"

/**
 * Pull down at the top of any page to refresh what it shows, as native lists do. Installed web
 * apps lose the browser's own pull-to-refresh, so this restores it for the app's data: the page
 * follows the finger with a rubber band, the activity indicator draws its ticks in the gap under
 * the top bar as the pull arms, and every query on screen refetches without reloading the app.
 * An element that owns vertical drags opts out with `data-no-pull-refresh`.
 */
export function PullToRefresh() {
  const queryClient = useQueryClient()
  const indicator = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const phone = window.matchMedia(PHONE_QUERY)
    const element = indicator.current
    if (!element) return

    let scroller: HTMLElement | null = null
    let content: HTMLElement[] = []
    let startY = 0
    let startX = 0
    let pull = 0
    let pulling = false
    let refreshing = false

    const move = (distance: number, transition: string) => {
      for (const child of content) {
        child.style.transition = transition
        child.style.transform = distance > 0 ? `translate3d(0, ${distance}px, 0)` : ""
      }
      element.style.transition = transition
      element.style.transform = `translate3d(-50%, ${Math.max(0, distance / 2 - 14)}px, 0)`
    }

    const show = (distance: number) => {
      move(distance, "none")
      const progress = Math.min(distance / TRIGGER, 1)
      element.style.setProperty("--pull-progress", String(progress))
      element.style.opacity = String(Math.min(distance / 28, 1))
      element.toggleAttribute("data-armed", distance >= TRIGGER)
    }

    const hide = () => {
      move(0, SETTLE)
      element.style.opacity = "0"
      element.removeAttribute("data-armed")
      element.removeAttribute("data-refreshing")
      const settled = content
      window.setTimeout(() => {
        for (const child of settled) child.style.transition = ""
      }, 400)
    }

    // Moves are only blocked while a pull may start, so every other scroll starts without waiting
    // on script.
    const track = (page: HTMLElement | null) => {
      if (page && !scroller) document.addEventListener("touchmove", onMove, { passive: false })
      if (!page && scroller) document.removeEventListener("touchmove", onMove)
      scroller = page
    }

    const onStart = (event: TouchEvent) => {
      track(null)
      if (!phone.matches || refreshing || event.touches.length !== 1) return
      const target = event.target instanceof Element ? event.target : null
      const page = appScroller()
      if (!target || !page || !page.contains(target)) return
      if (
        target.closest(
          '[role="dialog"], [data-no-pull-refresh], input, textarea, [contenteditable="true"]'
        )
      )
        return
      if (scrolledAbove(target, page)) return
      track(page)
      startY = event.touches[0].clientY
      startX = event.touches[0].clientX
      pulling = false
    }

    const onMove = (event: TouchEvent) => {
      if (!scroller) return
      const touch = event.touches[0]
      const dy = touch.clientY - startY
      if (!pulling) {
        if (Math.abs(touch.clientX - startX) > Math.abs(dy) || dy < 0) return track(null)
        if (dy < 6) return
        pulling = true
        content = [...scroller.children].filter(
          (child): child is HTMLElement => child instanceof HTMLElement
        )
      }
      event.preventDefault()
      // Resistance grows with distance, as a rubber band does.
      const travel = dy - 6
      pull = Math.min(MAX_PULL, travel * 0.55 - Math.max(0, travel - TRIGGER * 1.6) * 0.18)
      show(Math.max(0, pull))
    }

    const onEnd = async () => {
      const wasPulling = scroller !== null && pulling
      track(null)
      if (!wasPulling) return
      pulling = false
      if (pull < TRIGGER) {
        hide()
        return
      }
      refreshing = true
      haptic()
      move(REST, SETTLE)
      element.style.setProperty("--pull-progress", "1")
      element.setAttribute("data-refreshing", "")
      const started = performance.now()
      try {
        await queryClient.refetchQueries({ type: "active" })
      } finally {
        const wait = MIN_SPIN_MS - (performance.now() - started)
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        refreshing = false
        hide()
      }
    }

    document.addEventListener("touchstart", onStart, { passive: true })
    document.addEventListener("touchend", onEnd)
    document.addEventListener("touchcancel", onEnd)
    return () => {
      track(null)
      document.removeEventListener("touchstart", onStart)
      document.removeEventListener("touchend", onEnd)
      document.removeEventListener("touchcancel", onEnd)
      for (const child of content) {
        child.style.transition = ""
        child.style.transform = ""
      }
    }
  }, [queryClient])

  return (
    <div ref={indicator} className="pull-refresh" aria-hidden="true">
      <svg viewBox="0 0 28 28" className="pull-refresh-spinner">
        {Array.from({ length: TICKS }, (_, tick) => (
          <line
            key={tick}
            x1="14"
            y1="3.5"
            x2="14"
            y2="8.5"
            transform={`rotate(${tick * (360 / TICKS)} 14 14)`}
            style={{ "--tick": tick } as CSSProperties}
          />
        ))}
      </svg>
    </div>
  )
}

/** Whether the page, or a pane between it and the touch, is scrolled away from its top. */
function scrolledAbove(target: Element, page: HTMLElement): boolean {
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node.scrollTop > 0) return true
    if (node === page) return false
  }
  return false
}

/**
 * A light tap of the Taptic Engine where the platform allows a web page one, else nothing. iOS has
 * no vibration API for the web, but toggling a native switch plays the system's selection haptic,
 * including one toggled through its label from script while a touch is being handled.
 */
function haptic(): void {
  if (isIOS()) {
    const label = document.createElement("label")
    label.ariaHidden = "true"
    label.style.display = "none"
    const input = document.createElement("input")
    input.type = "checkbox"
    input.setAttribute("switch", "")
    label.append(input)
    document.head.append(label)
    label.click()
    label.remove()
    return
  }
  navigator.vibrate?.(8)
}
