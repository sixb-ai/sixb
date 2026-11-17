import { useDesktop } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

/** The systems the desktop app is released for. */
export type DesktopDownloadPlatform = "darwin"

/**
 * What people download, where the deployment serves it on the app's own origin: `sixb desktop
 * release` publishes it there.
 */
const INSTALLERS: Readonly<
  Record<DesktopDownloadPlatform, { readonly path: string; readonly extension: string }>
> = {
  darwin: { path: "/__sixb/desktop/darwin/install.dmg", extension: "dmg" },
}

export interface DesktopDownload {
  readonly platform: DesktopDownloadPlatform
  readonly href: string
  /** Named after the app, as the installed app is. */
  readonly fileName: string
}

interface NavigatorLike {
  readonly userAgent: string
  readonly maxTouchPoints?: number
  readonly userAgentData?: { readonly platform?: string }
}

/** The system this browser runs on, when the desktop app is released for it. */
export function desktopPlatformOf(navigator: NavigatorLike): DesktopDownloadPlatform | null {
  const hinted = navigator.userAgentData?.platform
  if (hinted) return hinted === "macOS" ? "darwin" : null
  // An iPad asks for sites as a Mac does, but has a touch screen.
  if (/Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) <= 1) {
    return "darwin"
  }
  return null
}

/**
 * The desktop app to offer this browser: one released for its system, and not to someone already
 * in it. Null until a release is known to exist.
 */
export function useDesktopDownload(appName: string): DesktopDownload | null {
  const desktop = useDesktop()
  const [platform] = useState(() =>
    typeof navigator === "undefined" ? null : desktopPlatformOf(navigator)
  )
  const installer = platform ? INSTALLERS[platform] : null
  const released = useQuery({
    queryKey: ["sixb", "desktop-download", platform],
    queryFn: async () => (installer ? (await fetch(installer.path, { method: "HEAD" })).ok : false),
    enabled: installer !== null && desktop === null,
    // A release while the page is open shows on the next visit.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  if (!platform || !installer || desktop || released.data !== true) return null
  return {
    platform,
    href: installer.path,
    fileName: `${appName.replaceAll(/[\\/:*?"<>|]/g, "-").trim() || "Install"}.${installer.extension}`,
  }
}
