import { type RefObject, useEffect, useRef } from "react"

/**
 * Calls `onNear` each time an element comes within `margin` of the screen, while `active`. Where
 * the browser cannot tell, it never calls it.
 */
export function useNearScreen(
  element: RefObject<Element | null>,
  margin: string,
  onNear: () => void,
  active: boolean
): void {
  const callback = useRef(onNear)
  callback.current = onNear
  useEffect(() => {
    const target = element.current
    if (!active || !target || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current()
      },
      { rootMargin: margin }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [element, margin, active])
}
