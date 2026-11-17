import { MAC_FEED, releaseUrl } from "../release"
import type { ShellConfig } from "./navigation"

/** How often a running app asks for a new version, besides once at launch. */
export const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000

/** The part of Electron's `autoUpdater` the shell uses. */
export interface Updater {
  setFeedURL(options: { readonly url: string; readonly serverType: "json" }): void
  checkForUpdates(): void
  on(event: "update-downloaded", listener: () => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
}

/**
 * Keeps an installed app current from the deployment that serves it: a new version downloads in the
 * background and takes over the next time the app starts. Nothing shows on screen.
 *
 * Only a packaged macOS app updates, and only one signed with a Developer ID: macOS checks that the
 * new version is signed by the same developer, so an unsigned build can't update and doesn't try.
 */
export function keepUpToDate(config: ShellConfig, updater: Updater): void {
  try {
    updater.setFeedURL({ url: releaseUrl(config.appUrl, "darwin", MAC_FEED), serverType: "json" })
  } catch (error) {
    // Signed ad hoc, as a build without Apple credentials is.
    console.error(`[SixbDesktop] This app can't update itself: ${messageOf(error)}`)
    return
  }

  const check = () => {
    try {
      updater.checkForUpdates()
    } catch (error) {
      console.error(`[SixbDesktop] Could not check for an update: ${messageOf(error)}`)
    }
  }
  updater.on("error", (error) => {
    // Offline, or the deployment serves no release: the next check tries again.
    console.error(`[SixbDesktop] Could not check for an update: ${error.message}`)
  })
  const interval = setInterval(check, UPDATE_INTERVAL_MS)
  // Checking again would download the same version again.
  updater.on("update-downloaded", () => clearInterval(interval))
  check()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
