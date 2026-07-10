import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { extname, join } from "node:path"
import { pathToFileURL } from "node:url"

export interface AppMetadata {
  title?: string
  description?: string
  favicon?: string
  themeColor?: string
  backgroundColor?: string
}

export interface ResolvedManifestIcon {
  readonly src: string
  readonly sizes?: string
  readonly type?: string
  readonly purpose?: "any" | "maskable"
}

export interface ResolvedAppMetadata {
  readonly title: string
  readonly description?: string
  readonly favicon?: string
  readonly themeColor: string
  readonly backgroundColor: string
  readonly appleTouchIcon?: string
  readonly icons: readonly ResolvedManifestIcon[]
}

export interface ResolveAppMetadataOptions {
  readonly layoutPath: string
  readonly publicDir: string
}

const metadataRequire = createRequire(import.meta.url)

const metadataFields = [
  "title",
  "description",
  "favicon",
  "themeColor",
  "backgroundColor",
] as const satisfies readonly (keyof AppMetadata)[]

/** Loads, validates, defaults, and resolves all custom-app identity in one place. */
export async function resolveAppMetadata(
  options: ResolveAppMetadataOptions
): Promise<ResolvedAppMetadata> {
  const configured = await loadConfiguredMetadata(options.layoutPath)
  validateMetadata(configured, options.layoutPath)

  const conventionalFaviconPath = join(options.publicDir, "favicon.svg")
  const favicon =
    configured.favicon ?? ((await fileExists(conventionalFaviconPath)) ? "/favicon.svg" : undefined)
  const themeColor = configured.themeColor ?? configured.backgroundColor ?? "#ffffff"
  const backgroundColor = configured.backgroundColor ?? themeColor
  const icons: ResolvedManifestIcon[] = []

  if (await fileExists(join(options.publicDir, "icon-192.png"))) {
    icons.push({
      src: "/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    })
  }
  if (await fileExists(join(options.publicDir, "icon-512.png"))) {
    icons.push({
      src: "/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    })
  }
  if (await fileExists(join(options.publicDir, "icon-maskable-512.png"))) {
    icons.push({
      src: "/icon-maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    })
  }

  const hasStandardIcon = icons.some((icon) => icon.purpose === "any")
  if (!hasStandardIcon && favicon) {
    const type = inferImageMimeType(favicon)
    if (type) {
      icons.push({
        src: favicon,
        ...(type === "image/svg+xml" ? { sizes: "any" } : {}),
        type,
        purpose: "any",
      })
    }
  }

  return {
    title: configured.title ?? "Sixb",
    ...(configured.description ? { description: configured.description } : {}),
    ...(favicon ? { favicon } : {}),
    themeColor,
    backgroundColor,
    ...((await fileExists(join(options.publicDir, "apple-touch-icon.png")))
      ? { appleTouchIcon: "/apple-touch-icon.png" }
      : {}),
    icons,
  }
}

async function loadConfiguredMetadata(layoutPath: string): Promise<AppMetadata> {
  if (!(await fileExists(layoutPath))) {
    return {}
  }

  try {
    const sourceHash = createHash("sha256")
      .update(await readFile(layoutPath))
      .digest("hex")
    const url = pathToFileURL(layoutPath)
    // Bun currently canonicalizes file-URL query strings in its module cache.
    // Explicit invalidation makes the source fingerprint a reliable dev cache
    // buster while retaining a normal file URL and relative import behavior.
    delete metadataRequire.cache[metadataRequire.resolve(layoutPath)]
    url.searchParams.set("sixb-metadata", sourceHash)
    const layoutModule = (await import(url.href)) as { readonly metadata?: unknown }

    if (layoutModule.metadata === undefined) {
      return {}
    }
    if (
      typeof layoutModule.metadata !== "object" ||
      layoutModule.metadata === null ||
      Array.isArray(layoutModule.metadata)
    ) {
      throw metadataError(layoutPath, "the named metadata export must be an object")
    }

    return layoutModule.metadata as AppMetadata
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[SixbCustomApp]")) {
      throw error
    }

    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `[SixbCustomApp] Could not load metadata from ${layoutPath}: ${detail}. ` +
        "App metadata is build-time configuration, so app/layout.tsx must be import-safe in Bun " +
        "and must not access window or document at module scope."
    )
  }
}

function validateMetadata(metadata: AppMetadata, layoutPath: string): void {
  for (const field of metadataFields) {
    const value = metadata[field]
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
      throw metadataError(layoutPath, `metadata.${field} must be a non-empty string when provided`)
    }
  }
}

function metadataError(layoutPath: string, detail: string): Error {
  return new Error(`[SixbCustomApp] Invalid app metadata in ${layoutPath}: ${detail}`)
}

function inferImageMimeType(url: string): string | undefined {
  if (url.startsWith("data:")) {
    const match = /^data:(image\/[a-z0-9.+-]+)/i.exec(url)
    return match?.[1]?.toLowerCase()
  }

  let pathname = url
  try {
    pathname = new URL(url, "https://sixb.invalid").pathname
  } catch {
    // Fall back to extension parsing on the configured value.
  }

  switch (extname(pathname).toLowerCase()) {
    case ".svg":
      return "image/svg+xml"
    case ".png":
      return "image/png"
    case ".ico":
      return "image/x-icon"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".webp":
      return "image/webp"
    case ".avif":
      return "image/avif"
    default:
      return undefined
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
