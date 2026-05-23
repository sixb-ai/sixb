import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface BuildAppOptions {
  /** Path to the generated index.html entry point */
  entryPath: string
  /** Output directory, defaults to `.sixb/dist/app` */
  outdir?: string
}

export interface BuildAppResult {
  success: boolean
  outdir: string
  logs?: string[]
}

/**
 * Builds the app using `Bun.build()` on the generated HTML entry point.
 * Outputs a production-ready static bundle.
 */
export async function buildApp(options: BuildAppOptions): Promise<BuildAppResult> {
  const outdir = options.outdir ?? join(process.cwd(), ".sixb", "dist", "app")
  await mkdir(outdir, { recursive: true })

  const result = await Bun.build({
    entrypoints: [options.entryPath],
    outdir,
    target: "browser",
    publicPath: "/",
    minify: true,
    sourcemap: "external",
  })

  if (!result.success) {
    return {
      success: false,
      outdir,
      logs: result.logs.map(String),
    }
  }

  await rewriteIndexAssetPaths(outdir)

  return { success: true, outdir }
}

async function rewriteIndexAssetPaths(outdir: string): Promise<void> {
  const indexPath = join(outdir, "index.html")
  const html = await readFile(indexPath, "utf-8")

  const rewritten = html.replace(
    /(href|src)=(["'])((?!\/|#|[a-zA-Z][a-zA-Z\d+.-]*:)(?:\.\/)?[^"'?#]+(?:[?#][^"']*)?)\2/g,
    (_match, attr: string, quote: string, url: string) => {
      const normalized = url.startsWith("./") ? url.slice(2) : url
      return `${attr}=${quote}/${normalized}${quote}`
    }
  )

  if (rewritten !== html) {
    await writeFile(indexPath, rewritten, "utf-8")
  }
}
