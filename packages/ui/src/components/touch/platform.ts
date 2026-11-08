/** The phone layout's breakpoint, as the stylesheets write it. */
export const PHONE_QUERY = "(max-width: 767px)"

/** Whether the page runs as an app added to the Home Screen, rather than in a browser tab. */
export function isInstalledApp(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** An iPhone or iPad, including an iPad whose Safari presents itself as a Mac. */
export function isIOS(): boolean {
  return (
    /iP(?:hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent))
  )
}
