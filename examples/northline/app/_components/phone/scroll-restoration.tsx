import { useEffect, useLayoutEffect, useRef } from "react"
import { useLocation, useNavigationType } from "react-router-dom"

// Data can take a moment to arrive; until the page is tall enough the saved position can't apply.
const RESTORE_WINDOW_MS = 1500

/**
 * The app scrolls inside one container that stays mounted between pages, so the browser can't
 * manage its position. A new screen starts at the top; Back returns to where the previous screen
 * was left. Changing only the query string, such as a filter, keeps the position.
 */
export function ScrollRestoration() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const positions = useRef(new Map<string, number>())
  const previousPath = useRef(location.pathname)

  useEffect(() => {
    const scroller = appScroller()
    if (!scroller) return
    const key = location.key
    const save = () => positions.current.set(key, scroller.scrollTop)
    scroller.addEventListener("scroll", save, { passive: true })
    return () => scroller.removeEventListener("scroll", save)
  }, [location.key])

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per navigation, keyed by it.
  useLayoutEffect(() => {
    const scroller = appScroller()
    const samePath = previousPath.current === location.pathname
    previousPath.current = location.pathname
    if (!scroller || (navigationType !== "POP" && samePath)) return

    const target = navigationType === "POP" ? (positions.current.get(location.key) ?? 0) : 0
    scroller.scrollTop = target
    if (target === 0) return

    let frame = 0
    let interrupted = false
    const started = performance.now()
    const interrupt = () => {
      interrupted = true
    }
    const retry = () => {
      if (interrupted) return
      if (scroller.scrollHeight - scroller.clientHeight >= target) {
        scroller.scrollTop = target
        return
      }
      if (performance.now() - started < RESTORE_WINDOW_MS) frame = requestAnimationFrame(retry)
    }
    scroller.addEventListener("touchstart", interrupt, { passive: true })
    scroller.addEventListener("wheel", interrupt, { passive: true })
    frame = requestAnimationFrame(retry)

    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener("touchstart", interrupt)
      scroller.removeEventListener("wheel", interrupt)
    }
  }, [location.key])

  return null
}

function appScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-app-scroll]")
}
