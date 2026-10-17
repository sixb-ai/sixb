/** What the desktop app takes from the web app it opens. */
export interface AppIdentity {
  /** The app's name: `metadata.title` in `app/layout.tsx`. */
  readonly name: string
  /**
   * The app's maskable icon, such as `app/public/icon-maskable-512.png`, or else its largest PNG
   * icon, such as `app/public/icon-512.png`.
   */
  readonly icon: Uint8Array | null
}

/**
 * Reads the app's web app manifest, the one a browser installs the app from. The desktop app is
 * the same app installed another way, so it takes the same name and icon and has no settings of
 * its own.
 */
export async function readAppIdentity(appUrl: string): Promise<AppIdentity> {
  const manifestUrl = new URL("/app.webmanifest", appUrl)
  const manifest: unknown = await (await fetchFromApp(manifestUrl)).json()
  const { name, icons } = (typeof manifest === "object" && manifest !== null ? manifest : {}) as {
    readonly name?: unknown
    readonly icons?: unknown
  }

  const iconUrl = desktopIcon(icons, manifestUrl)
  return {
    name: typeof name === "string" && name.trim() ? name.trim() : "Sixb",
    icon: iconUrl ? new Uint8Array(await (await fetchFromApp(iconUrl)).arrayBuffer()) : null,
  }
}

/**
 * The app's id on the desktop, from the address it opens: `https://orders.acme.com` becomes
 * `com.acme.orders`. Each deployment gets its own, so a staging build installs beside production.
 */
export function bundleIdentifier(appUrl: string): string {
  const labels = new URL(appUrl).hostname
    .split(".")
    .reverse()
    .map((label) => label.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-"))
    .filter(Boolean)
  return (labels.length > 1 ? labels : ["local", ...labels]).join(".")
}

// A maskable icon is drawn to its edges for a platform to cut its own shape from, which is what
// macOS does with it. Any other icon may carry its own shape and margins.
function desktopIcon(icons: unknown, manifestUrl: URL): URL | null {
  let best: { readonly url: URL; readonly rank: readonly [number, number] } | null = null
  for (const icon of Array.isArray(icons) ? icons : []) {
    if (typeof icon !== "object" || icon === null) continue
    const { src, sizes, type, purpose } = icon as Record<string, unknown>
    if (typeof src !== "string") continue
    const url = new URL(src, manifestUrl)
    if (type === undefined ? !url.pathname.endsWith(".png") : type !== "image/png") continue

    const maskable = typeof purpose === "string" && purpose.split(/\s+/).includes("maskable")
    const size = Math.max(
      0,
      ...(typeof sizes === "string" ? sizes.split(/\s+/) : []).map(
        (entry) => Number.parseInt(entry, 10) || 0
      )
    )
    const rank = [maskable ? 1 : 0, size] as const
    if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) {
      best = { url, rank }
    }
  }
  return best?.url ?? null
}

async function fetchFromApp(url: URL): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new Error(
      `[SixbDesktop] Could not reach ${url} (${error instanceof Error ? error.message : error}). ` +
        "The desktop app takes its name and icon from the app, so the app must be running there."
    )
  }
  if (!response.ok) throw new Error(`[SixbDesktop] ${url} answered ${response.status}.`)
  return response
}
