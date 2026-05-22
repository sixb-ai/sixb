import { access } from "node:fs/promises"
import { isAbsolute, normalize, relative, resolve } from "node:path"

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function createPublicRoutes(
  publicDir: string
): Promise<Record<string, () => Response | Promise<Response>>> {
  const files = new Bun.Glob("**/*").scan({
    cwd: publicDir,
    absolute: true,
    onlyFiles: true,
  })
  const routes: Record<string, () => Response | Promise<Response>> = {}

  for await (const filePath of files) {
    routes[toPublicPath(publicDir, filePath)] = () => new Response(Bun.file(filePath))
  }

  return routes
}

export async function collectPublicAssetPaths(publicDir: string): Promise<Set<string>> {
  const files = new Bun.Glob("**/*").scan({
    cwd: publicDir,
    absolute: true,
    onlyFiles: true,
  })
  const paths = new Set<string>()

  for await (const filePath of files) {
    paths.add(toPublicPath(publicDir, filePath))
  }

  return paths
}

export function safeResolvePath(rootDir: string, pathname: string): string | null {
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return null
  }

  if (decodedPath.includes("\0")) return null
  const segments = decodedPath.split(/[\\/]+/)
  if (segments.includes("..")) return null

  const normalizedPath = normalize(decodedPath).replace(/^[\\/]+/, "")
  const resolvedPath = resolve(rootDir, normalizedPath)
  const rel = relative(rootDir, resolvedPath)

  if (rel.startsWith("..") || isAbsolute(rel)) return null
  return resolvedPath
}

export function toUrlPath(rootDir: string, targetPath: string): string {
  const relativePath = relative(rootDir, targetPath).split("\\").join("/")
  return `/${relativePath.replace(/^\/+/, "")}`
}

export function isAssetPath(pathname: string): boolean {
  const lastSegment = pathname.split("/").pop() ?? ""
  return /\.[^/]+$/.test(lastSegment)
}

export function isHtmlPath(pathname: string): boolean {
  return pathname.toLowerCase().endsWith(".html")
}

function toPublicPath(publicDir: string, filePath: string): string {
  return `/${filePath
    .slice(publicDir.length + 1)
    .split("\\")
    .join("/")}`
}
