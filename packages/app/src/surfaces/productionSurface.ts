import { join } from "node:path"
import { isHtmlPath, pathExists, safeResolvePath } from "./paths"
import type { AppAsset, CustomAppProductionMount } from "./types"

export interface CreateProductionMountOptions {
  readonly outdir: string
  readonly apiBaseUrl?: string
}

export async function createProductionMount(
  options: CreateProductionMountOptions
): Promise<CustomAppProductionMount> {
  const indexPath = join(options.outdir, "index.html")

  if (!(await pathExists(indexPath))) {
    throw new Error(`[ParioApp] No built app found in ${options.outdir}`)
  }

  async function readHtml(path: string): Promise<string> {
    return injectApiBaseUrl(await Bun.file(path).text(), options.apiBaseUrl)
  }

  return {
    kind: "production",

    async indexHtml() {
      return await readHtml(indexPath)
    },

    async asset(pathname) {
      if (isHtmlPath(pathname)) {
        return null
      }

      const resolvedPath = safeResolvePath(options.outdir, pathname)
      if (!resolvedPath) {
        return null
      }

      const file = Bun.file(resolvedPath)
      if (!(await file.exists())) {
        return null
      }

      return {
        body: file,
        contentType: file.type || undefined,
        cacheControl: "public, max-age=31536000, immutable",
      } satisfies AppAsset
    },

    async html(pathname) {
      const resolvedPath = safeResolvePath(options.outdir, pathname)
      if (!resolvedPath) {
        return null
      }

      const candidates = isHtmlPath(pathname)
        ? [resolvedPath]
        : [`${resolvedPath}.html`, join(resolvedPath, "index.html")]

      for (const candidate of candidates) {
        const file = Bun.file(candidate)
        if (await file.exists()) {
          return await readHtml(candidate)
        }
      }

      return null
    },

    async stop() {},
  }
}

export function injectApiBaseUrl(html: string, apiBaseUrl?: string): string {
  if (!apiBaseUrl) {
    return html
  }

  const runtimeConfig = JSON.stringify({
    api: {
      baseUrl: apiBaseUrl,
    },
  }).replaceAll("<", "\\u003c")
  const script = `<script>window.__PARIO_RUNTIME__ = ${runtimeConfig};</script>`
  if (html.includes("</head>")) {
    return html.replace("</head>", `  ${script}\n  </head>`)
  }

  return `${script}\n${html}`
}
