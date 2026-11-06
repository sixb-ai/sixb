import { useEffect, useRef } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { suppressNextNavigationMotion } from "./navigation-motion"
import { isRootPath, parentPath, screenPath } from "./phone-routes"

const EDGE = 24
const PHONE = "(max-width: 767px)"

/**
 * The iOS back gesture. Safari provides it in the browser, but an installed web app has none, so
 * in standalone mode a swipe from the left edge of a pushed screen drags the page away and goes
 * back, exactly as the top bar's back button would.
 */
export function SwipeBack() {
  const location = useLocation()
  const navigate = useNavigate()
  const current = useRef(location)
  current.current = location

  useEffect(() => {
    const standalone =
      matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    if (!standalone) return
    const phone = matchMedia(PHONE)

    let page: HTMLElement | null = null
    let startX = 0
    let startY = 0
    let offset = 0
    let velocity = 0
    let lastX = 0
    let lastTime = 0
    let dragging = false

    const back = () => {
      const { key, pathname, search } = current.current
      if (key !== "default") navigate(-1)
      else navigate(parentPath(screenPath(pathname, search)), { replace: true })
    }

    const settle = (element: HTMLElement, to: number, done?: () => void) => {
      element.style.transition = "transform 280ms cubic-bezier(0.32, 0.72, 0, 1)"
      element.style.transform = to === 0 ? "" : `translate3d(${to}px, 0, 0)`
      element.addEventListener(
        "transitionend",
        () => {
          element.style.transition = ""
          done?.()
        },
        { once: true }
      )
    }

    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!phone.matches || event.touches.length !== 1 || touch.clientX > EDGE) return
      if (isRootPath(screenPath(current.current.pathname, current.current.search))) return
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [data-vaul-drawer][data-state="open"]'
        )
      ) {
        return
      }
      // A conversation fills the screen above the page scroller, so it is what moves.
      page =
        document.querySelector<HTMLElement>('[data-agent-surface="full"]') ??
        document.querySelector<HTMLElement>("[data-app-scroll]")
      startX = lastX = touch.clientX
      startY = touch.clientY
      lastTime = event.timeStamp
      dragging = false
    }

    const onMove = (event: TouchEvent) => {
      if (!page) return
      const touch = event.touches[0]
      const dx = touch.clientX - startX
      if (!dragging) {
        if (Math.abs(touch.clientY - startY) > Math.abs(dx)) {
          page = null
          return
        }
        if (dx < 8) return
        dragging = true
        page.style.transition = "none"
        page.style.boxShadow = "-12px 0 28px rgb(0 0 0 / 0.08)"
      }
      event.preventDefault()
      offset = Math.max(0, dx)
      velocity = (touch.clientX - lastX) / Math.max(1, event.timeStamp - lastTime)
      lastX = touch.clientX
      lastTime = event.timeStamp
      page.style.transform = `translate3d(${offset}px, 0, 0)`
    }

    const onEnd = () => {
      const element = page
      page = null
      if (!element || !dragging) return
      dragging = false
      const width = element.offsetWidth
      if (offset > width * 0.33 || velocity > 0.5) {
        settle(element, width, () => {
          suppressNextNavigationMotion()
          back()
          requestAnimationFrame(() => {
            element.style.transform = ""
            element.style.boxShadow = ""
          })
        })
      } else {
        settle(element, 0, () => {
          element.style.boxShadow = ""
        })
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
  }, [navigate])

  return null
}
