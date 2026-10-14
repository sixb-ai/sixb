declare global {
  interface Window {
    __SIXB_ATLAS__?: { readonly appUrl?: string }
  }
}

/**
 * Where a page that moved into the project's app now lives, or `null` when Atlas was not told the
 * app's address. Settings moved first; the rest of Atlas follows section by section.
 */
export function projectAppUrl(path: string): string | null {
  const appUrl = typeof window === "undefined" ? undefined : window.__SIXB_ATLAS__?.appUrl
  return appUrl ? new URL(path, appUrl).toString() : null
}
