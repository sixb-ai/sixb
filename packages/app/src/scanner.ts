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
      if (dir === appDir && name === "shared") {
        throw new Error(
          "[SixbCustomApp] app/shared is reserved for framework-managed shared links. " +
            "Move this page to another route."
        )
      }
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
