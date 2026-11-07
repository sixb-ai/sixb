import { useLayoutEffect, useRef } from "react"
import { useLocation, useNavigationType } from "react-router-dom"
import { appScroller } from "./phone-dom"
import { isRootPath, screenPath, tabFor } from "./phone-routes"

type NavigationMotionKind = "push" | "pop" | "switch"

let suppressed = false

/** Skip the next screen's entrance, for a navigation the person already animated by hand. */
export function suppressNextNavigationMotion(): void {
  suppressed = true
}

/**
 * Tells the page scroller how the next screen arrived, so phone CSS can move it the way native
 * navigation does: a pushed screen slides in from the right, Back slides the previous one in
 * from the left, and switching tabs only cross-fades (see phone-shell.css).
 */
export function NavigationMotion() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const previousPath = useRef(screenPath(location.pathname, location.search))

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per navigation, keyed by it.
  useLayoutEffect(() => {
    const scroller = appScroller()
    const from = previousPath.current
    const to = screenPath(location.pathname, location.search)
    previousPath.current = to
    if (!scroller || from === to) return

    // Home and its conversations share a tab; a new chat simply replaces the page.
    const fromHome = from === "/" || to === "/"
    if (suppressed || (fromHome && tabFor(from) === tabFor(to))) {
      suppressed = false
      delete scroller.dataset.motion
      return
    }

    const kind: NavigationMotionKind =
      tabFor(from) !== tabFor(to) || (isRootPath(from) && isRootPath(to))
        ? "switch"
        : navigationType === "POP"
          ? "pop"
          : "push"
    scroller.dataset.motion = kind

    // Only the arriving screen moves; content that mounts once its data loads stays still.
    const settle = window.setTimeout(() => delete scroller.dataset.motion, 420)
    return () => window.clearTimeout(settle)
  }, [location.key])

  return null
}
