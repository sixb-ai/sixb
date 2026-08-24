import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"

export interface PageRoute {
  /** React Router path, e.g. "/" or "/remote/:id" */
  path: string
  /** Absolute file path */
  filePath: string
  /** Relative path from the app directory, e.g. "remote/[id]/page.tsx" */
  relativePath: string
}

export interface SharedPageRoute extends PageRoute {
  /** ShareType selected by the static directory below `app/shared/`. */
  shareTypeId: string
}

export interface PartitionedAppRoutes {
  applicationRoutes: PageRoute[]
  sharedRoutes: SharedPageRoute[]
}

/**
 * Reserves `app/shared/` for the isolated shared-access entry point.
 *
 * Keeping one canonical shape makes public exposure explicit and lets the
 * generated runtime bind the static ShareType to the grant returned by the API.
 */
export function partitionAppRoutes(routes: readonly PageRoute[]): PartitionedAppRoutes {
  const applicationRoutes: PageRoute[] = []
  const sharedRoutes: SharedPageRoute[] = []

  for (const route of routes) {
    const segments = route.relativePath.split(/[\\/]+/)
    if (segments[0] !== "shared") {
      applicationRoutes.push(route)
      continue
    }

    const shareTypeId = segments[1]
    if (
      segments.length !== 4 ||
      !shareTypeId ||
      shareTypeId.startsWith("[") ||
      segments[2] !== "[grantId]" ||
      (segments[3] !== "page.tsx" && segments[3] !== "page.ts")
    ) {
      throw new Error(
        `[SixbCustomApp] Shared pages must use app/shared/<shareTypeId>/[grantId]/page.tsx; found app/${route.relativePath.split("\\").join("/")}.`
      )
    }

    sharedRoutes.push({ ...route, shareTypeId })
  }

  return { applicationRoutes, sharedRoutes }
}

/**
 * Recursively scans an `app/` directory for `page.tsx`/`page.ts` files and
 * converts them to React Router route paths.
 *
 * - `app/page.tsx`              -> `/`
 * - `app/about/page.tsx`        -> `/about`
 * - `app/remote/[id]/page.tsx`  -> `/remote/:id`
 * - Files starting with `_` are skipped.
 */
export async function scanPages(appDir: string): Promise<PageRoute[]> {
  const routes: PageRoute[] = []
  await walkDir(appDir, appDir, routes)
  routes.sort((a, b) => a.path.localeCompare(b.path))
  return routes
}

async function walkDir(dir: string, appDir: string, routes: PageRoute[]): Promise<void> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as import("node:fs").Dirent[]
  } catch {
    return
  }

  for (const entry of entries) {
    const name = String(entry.name)
    if (name.startsWith("_")) continue

    const fullPath = join(dir, name)

    if (entry.isDirectory()) {
      await walkDir(fullPath, appDir, routes)
      continue
    }

    if (!entry.isFile()) continue
    const isPageModule = name === "page.tsx" || name === "page.ts"
    if (!isPageModule) continue

    const relativePath = relative(appDir, fullPath)
    const routePath = filePathToRoutePath(relativePath)

    routes.push({
      path: routePath,
      filePath: fullPath,
      relativePath,
    })
  }
}

function filePathToRoutePath(filePath: string): string {
  // Remove extension
  let route = filePath.replace(/\.(tsx|ts)$/, "")

  // Normalize path separators
  route = route.split("\\").join("/")

  // Convert [param] to :param
  route = route.replace(/\[([^\]]+)\]/g, ":$1")

  // Remove trailing /page
  if (route === "page") return "/"
  route = route.replace(/\/page$/, "")

  // Ensure leading slash
  if (!route.startsWith("/")) route = `/${route}`

  return route
}
