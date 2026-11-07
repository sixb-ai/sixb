/*
 * Where a screen sits in a phone's navigation, read from its address alone: `/quotes` is a
 * top-level screen, `/quotes/q-1` a record pushed on it, and its first segment is its section.
 */

/** The phone layout's breakpoint, as the stylesheets write it. */
export const PHONE_QUERY = "(max-width: 767px)"

/** The page's scroll container, which the shell marks with `data-app-scroll`. */
export function appScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-app-scroll]")
}

export function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
}

/** A top-level screen, such as Home or a list: it shows its title, never a back button. */
export function isRootPath(pathname: string): boolean {
  return normalizePath(pathname).split("/").filter(Boolean).length <= 1
}

/** The section a screen belongs to: its first segment, or "" for Home. */
export function sectionOf(pathname: string): string {
  return normalizePath(pathname).split("/")[1] ?? ""
}

/** The screen above this one: the address without its last segment. */
export function parentPath(pathname: string): string {
  return normalizePath(pathname).replace(/\/[^/]+$/, "") || "/"
}

/** This history entry's place in the app's history, as the router counts it. */
export function historyIndex(state: unknown = window.history.state): number {
  const index = (state as { idx?: unknown } | null)?.idx
  return typeof index === "number" ? index : 0
}
