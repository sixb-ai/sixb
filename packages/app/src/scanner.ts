import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"

const dynamicSegmentPattern = /^\[([\w-]+)\]$/
const reservedRoutePrefixes = ["/api", "/auth", "/ws", "/docs", "/__sixb"] as const
const reservedRoutePaths = new Set(["/app.webmanifest"])

export interface PageRoute {
  /** React Router path, e.g. "/" or "/remote/:id" */
  path: string
  /** Absolute file path */
  filePath: string
  /** Relative path from the app directory, e.g. "remote/[id]/page.tsx" */
  relativePath: string
}

export interface AppRouteLayout {
  /** React Router prefix owned by this layout, e.g. "/remote/:id". */
  path: string
  /** Absolute file path. */
  filePath: string
  /** Relative path from the app directory, e.g. "remote/[id]/layout.tsx". */
  relativePath: string
}

export interface AppRouteDiscovery {
  readonly pages: readonly PageRoute[]
  /** Descendant layouts only. The root layout remains the global app wrapper. */
  readonly layouts: readonly AppRouteLayout[]
}

/**
 * Recursively scans an `app/` directory for page modules and descendant layouts.
 *
 * - `app/page.tsx`                    -> page `/`
 * - `app/about/page.tsx`              -> page `/about`
 * - `app/remote/[id]/page.tsx`        -> page `/remote/:id`
 * - `app/remote/[id]/layout.tsx`      -> layout `/remote/:id/**`
 * - `app/layout.tsx` remains the global wrapper and is not returned as a route layout.
 * - Files and folders starting with `_` are skipped.
 */
export async function scanAppRoutes(appDir: string): Promise<AppRouteDiscovery> {
  const pages: PageRoute[] = []
  const layouts: AppRouteLayout[] = []
  await walkDir(appDir, appDir, pages, layouts)
  pages.sort(compareRouteModules)
  layouts.sort(compareRouteModules)
  return { pages, layouts }
}

/** Preserve the existing flat inspection contract while route generation uses the richer scan. */
export async function scanPages(appDir: string): Promise<PageRoute[]> {
  return [...(await scanAppRoutes(appDir)).pages]
}

/** Treat parameter names as labels when comparing route ownership and overrides. */
export function routePatternKey(path: string): string {
  if (path === "/") return "/"
  const segments = routeSegments(path).map((segment) =>
    segment.startsWith(":") ? ":" : segment.toLowerCase()
  )
  return `/${segments.join("/")}`
}

async function walkDir(
  dir: string,
  appDir: string,
  pages: PageRoute[],
  layouts: AppRouteLayout[]
): Promise<void> {
  const entries = await readDirectory(dir)
  if (!entries) return

  const visibleEntries = entries
    .filter((entry) => !String(entry.name).startsWith("_"))
    .sort((a, b) => compareText(String(a.name), String(b.name)))
  const relativeDir = normalizeRelativePath(relative(appDir, dir))

  validateChildDirectories(visibleEntries, relativeDir)

  const pageEntries = visibleEntries.filter(
    (entry) => entry.isFile() && (entry.name === "page.tsx" || entry.name === "page.ts")
  )
  if (pageEntries.length > 1) {
    const modules = pageEntries.map((entry) => displayAppPath(join(relativeDir, entry.name)))
    throw new Error(
      `[SixbCustomApp] Conflicting page modules for route '${directoryRoutePath(relativeDir)}': ${modules.join(" and ")}. Keep exactly one of page.tsx or page.ts.`
    )
  }

  const pageEntry = pageEntries[0]
  if (pageEntry) {
    const relativePath = normalizeRelativePath(join(relativeDir, pageEntry.name))
    const path = directoryRoutePath(relativeDir)
    assertRouteIsAvailable(path, relativePath)
    pages.push({ path, filePath: join(dir, pageEntry.name), relativePath })
  }

  if (relativeDir) {
    const layoutEntry = visibleEntries.find(
      (entry) => entry.isFile() && entry.name === "layout.tsx"
    )
    if (layoutEntry) {
      layouts.push({
        path: directoryRoutePath(relativeDir),
        filePath: join(dir, layoutEntry.name),
        relativePath: normalizeRelativePath(join(relativeDir, layoutEntry.name)),
      })
    }
  }

  for (const entry of visibleEntries) {
    if (!entry.isDirectory()) continue
    // `app/public/` is the static asset root, never part of the file router.
    if (!relativeDir && entry.name === "public") continue
    await walkDir(join(dir, entry.name), appDir, pages, layouts)
  }
}

async function readDirectory(dir: string): Promise<import("node:fs").Dirent[] | null> {
  try {
    return (await readdir(dir, { withFileTypes: true })) as import("node:fs").Dirent[]
  } catch (error) {
    if (isNotFoundError(error)) return null
    throw error
  }
}

function validateChildDirectories(
  entries: readonly import("node:fs").Dirent[],
  relativeDir: string
): void {
  const claimedSegments = new Map<string, string>()

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const segment = routeSegment(entry.name, join(relativeDir, entry.name))
    const key = segment.startsWith(":") ? ":" : segment.toLowerCase()
    const existing = claimedSegments.get(key)
    if (existing && existing !== entry.name) {
      const parent = relativeDir ? displayAppPath(relativeDir) : "app/"
      throw new Error(
        `[SixbCustomApp] Ambiguous route directories '${existing}' and '${entry.name}' under ${parent}. They match the same URL segment.`
      )
    }
    claimedSegments.set(key, entry.name)
  }
}

function directoryRoutePath(relativeDir: string): string {
  if (!relativeDir) return "/"
  return `/${relativeDir
    .split("/")
    .map((segment) => routeSegment(segment, relativeDir))
    .join("/")}`
}

function routeSegment(segment: string, relativePath: string): string {
  const dynamic = dynamicSegmentPattern.exec(segment)
  if (dynamic) return `:${dynamic[1]}`

  if (segment.includes("[") || segment.includes("]")) {
    throw new Error(
      `[SixbCustomApp] Invalid dynamic route directory ${displayAppPath(relativePath)}. Use one name such as '[id]'; catch-all and partial dynamic segments are not supported.`
    )
  }
  if (segment.includes("(") || segment.includes(")")) {
    throw new Error(
      `[SixbCustomApp] Invalid route directory ${displayAppPath(relativePath)}. Route groups are not supported yet; use a normal directory name.`
    )
  }
  if (/[:*?]/.test(segment)) {
    throw new Error(
      `[SixbCustomApp] Invalid route directory ${displayAppPath(relativePath)}. Use '[name]' for a dynamic segment; ':', '*' and '?' are reserved by React Router.`
    )
  }

  return segment
}

function assertRouteIsAvailable(path: string, relativePath: string): void {
  const normalizedPath = path.toLowerCase()
  const reserved =
    reservedRoutePaths.has(normalizedPath) ||
    reservedRoutePrefixes.some(
      (prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
    )
  if (!reserved) return

  throw new Error(
    `[SixbCustomApp] Page ${displayAppPath(relativePath)} resolves to reserved framework path '${path}'. Choose a route outside /api, /auth, /ws, /docs, /__sixb, and /app.webmanifest.`
  )
}

function routeSegments(path: string): string[] {
  return path === "/" ? [] : path.replace(/^\/+|\/+$/g, "").split("/")
}

function normalizeRelativePath(path: string): string {
  return path
    .split("\\")
    .join("/")
    .replace(/^\.\/$/, "")
}

function displayAppPath(path: string): string {
  const normalized = normalizeRelativePath(path)
  return normalized ? `app/${normalized}` : "app/"
}

function compareRouteModules(
  a: Pick<PageRoute, "path" | "relativePath">,
  b: Pick<PageRoute, "path" | "relativePath">
): number {
  return compareText(a.path, b.path) || compareText(a.relativePath, b.relativePath)
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}
