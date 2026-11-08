/** The phone layout's breakpoint, as the stylesheets write it. */
export const PHONE_QUERY = "(max-width: 767px)"

/** The page's scroll container, which the shell marks with `data-app-scroll`. */
export function appScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-app-scroll]")
}

/** Opened from the home screen as an installed app rather than in the browser. */
export function isInstalledApp(): boolean {
  return (
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** Whether anything from `target` up to `container` is scrolled away from its top. */
export function scrolledWithin(target: Element, container: HTMLElement): boolean {
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node.scrollTop > 0) return true
    if (node === container) return false
  }
  return false
}
