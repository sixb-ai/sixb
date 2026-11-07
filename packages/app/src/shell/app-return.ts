import type { QueryClient } from "@tanstack/react-query"
import { isInstalledApp } from "./phone/launch"

/** Away at least this long, the app refreshes what it shows when it comes back. */
export const REFRESH_AFTER_MS = 30_000

/**
 * Relaunched within this long of being left, the installed app opens on the screen it was left on.
 * iOS closes a web app in the background as it needs the memory, and opens it again at its start
 * page; a native app comes back where it was.
 */
export const RESTORE_WITHIN_MS = 30 * 60_000

const LAST_SCREEN_KEY = "sixb-last-screen"

export interface LeftScreen {
  /** The address, with its query string. */
  readonly path: string
  /** When the app was left, in milliseconds since the epoch. */
  readonly at: number
}

let refreshing = false
let remembering = false

/**
 * Refreshes every query on screen when the app comes back after `REFRESH_AFTER_MS` or longer in
 * the background, so returning to it shows what changed, as a native app does. Once per page.
 */
export function refreshOnReturn(queryClient: QueryClient): void {
  if (refreshing) return
  refreshing = true

  let hiddenAt: number | null = null
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now()
      return
    }
    if (hiddenAt !== null && Date.now() - hiddenAt >= REFRESH_AFTER_MS) {
      void queryClient.invalidateQueries()
    }
    hiddenAt = null
  })
}

/**
 * In the installed app, reopens the screen it was left on when it is launched again at its start
 * page within `RESTORE_WITHIN_MS`, before the first render, and remembers the screen each time the
 * app is left. Back from a reopened record climbs to its list (`useBack`). Browser tabs keep their
 * own history and are left alone.
 */
export function restoreLastScreen(): void {
  if (!isInstalledApp()) return

  const path = screenToReopen(readLeftScreen(), {
    path: window.location.pathname + window.location.search + window.location.hash,
    now: Date.now(),
  })
  if (path) window.history.replaceState(null, "", path)

  if (remembering) return
  remembering = true
  const remember = () => {
    writeLeftScreen({ path: window.location.pathname + window.location.search, at: Date.now() })
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") remember()
  })
  window.addEventListener("pagehide", remember)
}

/** The screen to reopen at launch, or null to open where iOS did. */
export function screenToReopen(
  left: LeftScreen | null,
  launch: { readonly path: string; readonly now: number }
): string | null {
  if (!left || launch.path !== "/") return null
  if (launch.now - left.at > RESTORE_WITHIN_MS || launch.now < left.at) return null
  if (left.path === "/" || !left.path.startsWith("/") || left.path.startsWith("//")) return null
  return left.path
}

function readLeftScreen(): LeftScreen | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LAST_SCREEN_KEY) ?? "null")
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as LeftScreen).path === "string" &&
      typeof (value as LeftScreen).at === "number"
    ) {
      return value as LeftScreen
    }
  } catch {
    // Storage blocked or the value unreadable: open where iOS did.
  }
  return null
}

function writeLeftScreen(screen: LeftScreen): void {
  try {
    localStorage.setItem(LAST_SCREEN_KEY, JSON.stringify(screen))
  } catch {
    // Storage blocked: the next launch opens at the start page.
  }
}
