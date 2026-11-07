/** The page's scroll container, which the shell marks with `data-app-scroll`. */
export function appScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-app-scroll]")
}
