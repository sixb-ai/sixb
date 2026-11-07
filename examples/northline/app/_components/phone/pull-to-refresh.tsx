import { useSidebar } from "@sixb/ui/components"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowDown } from "lucide-react"
import { useEffect, useRef } from "react"
import { appScroller, scrolledWithin } from "./phone-dom"

// How far the indicator travels, after resistance, before a release refreshes.
const TRIGGER = 64
const MAX_PULL = 110
const MIN_SPIN_MS = 600

/**
 * Pull down at the top of any page to refresh what it shows, as native lists do. Installed web
 * apps lose the browser's own pull-to-refresh, so this restores it for the app's data: every
 * query on screen refetches, without reloading the app.
 */
export function PullToRefresh() {
  const { isMobile } = useSidebar()
  return isMobile ? <PullIndicator /> : null
}

function PullIndicator() {
  const queryClient = useQueryClient()
  const indicator = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = indicator.current
    if (!element) return

    let scroller: HTMLElement | null = null
    let startY = 0
    let startX = 0
    let pull = 0
    let pulling = false
    let refreshing = false

    const show = (distance: number) => {
      element.style.transform = `translate3d(-50%, ${distance - 48}px, 0)`
      element.style.setProperty("--pull-turn", `${Math.min(distance / TRIGGER, 1) * 180}deg`)
      element.style.opacity = String(Math.min(distance / 40, 1))
      element.toggleAttribute("data-armed", distance >= TRIGGER)
    }

    const hide = () => {
      element.style.transition =
        "transform 260ms cubic-bezier(0.32, 0.72, 0, 1), opacity 200ms ease"
      element.style.transform = "translate3d(-50%, -48px, 0)"
      element.style.opacity = "0"
      element.removeAttribute("data-armed")
      element.removeAttribute("data-refreshing")
    }

    const onStart = (event: TouchEvent) => {
      if (refreshing || event.touches.length !== 1) return
      const target = event.target instanceof Element ? event.target : null
      const page = appScroller()
      if (!target || !page || !page.contains(target)) return
      if (target.closest('[role="dialog"], input, textarea, [contenteditable="true"]')) return
      if (scrolledWithin(target, page)) return
      scroller = page
      startY = event.touches[0].clientY
      startX = event.touches[0].clientX
      pulling = false
    }

    const onMove = (event: TouchEvent) => {
      if (!scroller) return
      const touch = event.touches[0]
      const dy = touch.clientY - startY
      if (!pulling) {
        if (Math.abs(touch.clientX - startX) > Math.abs(dy) || dy < 0) {
          scroller = null
          return
        }
        if (dy < 6) return
        pulling = true
        element.style.transition = "none"
      }
      event.preventDefault()
      // Resistance grows with distance, as a rubber band does.
      pull = Math.min(MAX_PULL, (dy - 6) * 0.5)
      show(pull)
    }

    const onEnd = async () => {
      if (!scroller || !pulling) {
        scroller = null
        return
      }
      scroller = null
      pulling = false
      if (pull < TRIGGER) {
        hide()
        return
      }
      refreshing = true
      element.style.transition = "transform 200ms cubic-bezier(0.32, 0.72, 0, 1)"
      element.style.transform = "translate3d(-50%, 14px, 0)"
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
    document.addEventListener("touchmove", onMove, { passive: false })
    document.addEventListener("touchend", onEnd)
    document.addEventListener("touchcancel", onEnd)
    return () => {
      document.removeEventListener("touchstart", onStart)
      document.removeEventListener("touchmove", onMove)
      document.removeEventListener("touchend", onEnd)
      document.removeEventListener("touchcancel", onEnd)
    }
  }, [queryClient])

  return (
    <div ref={indicator} className="pull-refresh" aria-hidden="true">
      <ArrowDown className="pull-refresh-arrow" strokeWidth={2.2} />
      <span className="pull-refresh-spinner" />
    </div>
  )
}
