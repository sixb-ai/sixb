import * as React from "react"

const MOBILE_BREAKPOINT = 768

/**
 * Whether the window is a phone's width now. `useIsMobile` answers false until its effect runs, so
 * code that acts on the first render asks this instead.
 */
export function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    // The query's own answer: on rotation iOS reports the change before `innerWidth` follows it, so
    // reading the width here would keep the old orientation's layout.
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener("change", onChange)
    setIsMobile(mql.matches)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
