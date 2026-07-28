import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

const STATIC_ASSET_ORIGIN = "https://sixb-static.invalid"

export interface BuildAppOptions {
  /** Path to the generated index.html entry point */
  entryPath: string
  /** Generated manifest copied to the stable `/app.webmanifest` output path. */
  manifestPath?: string
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
  // The outdir is build-owned. Clear it so hashed chunks from previous builds
  // don't accumulate (and get served) forever.
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })

  const bundleEntryPath = await prepareAppHtmlBundleEntry(options.entryPath)
  let result: Awaited<ReturnType<typeof Bun.build>>
  try {
    result = await Bun.build({
      entrypoints: [bundleEntryPath],
      outdir,
      target: "browser",
      conditions: ["bun"],
      publicPath: "/",
      minify: true,
      // React is bundled into this browser output, so without pinning NODE_ENV the production build
      // of a user's app ships React's development build: dev-only checks on every render, and the
      // warnings that go with them. This is also the only knob that selects the production JSX
      // runtime — an ambient NODE_ENV does not.
      define: { "process.env.NODE_ENV": '"production"' },
      sourcemap: "external",
    })
  } finally {
    await rm(bundleEntryPath, { force: true })
  }

  if (!result.success) {
    return {
      success: false,
      outdir,
      logs: result.logs.map(String),
    }
  }

  const bundleHtmlPath = join(outdir, basename(bundleEntryPath))
  await rename(bundleHtmlPath, join(outdir, "index.html"))
  await rewriteIndexAssetPaths(outdir)
  if (options.manifestPath) {
    await copyFile(options.manifestPath, join(outdir, "app.webmanifest"))
  }

  return { success: true, outdir }
}

// Bun's HTML bundler currently tries to resolve root-relative link assets from
// the filesystem root. A temporary external origin keeps these stable URLs out
// of the asset graph; dev responses and production output restore the originals.
export async function prepareAppHtmlBundleEntry(entryPath: string): Promise<string> {
  const html = await readFile(entryPath, "utf-8")
  const bundleHtml = html.replace(
    /(<link\s+rel=["'](?:manifest|icon|apple-touch-icon)["']\s+href=["'])(\/[^"']*)(["'][^>]*>)/g,
    `$1${STATIC_ASSET_ORIGIN}$2$3`
  )
  const bundleEntryPath = join(dirname(entryPath), "index.sixb-bundle.html")
  await writeFile(bundleEntryPath, bundleHtml, "utf-8")
  return bundleEntryPath
}

export function restoreAppStaticUrls(html: string): string {
  return html.replaceAll(STATIC_ASSET_ORIGIN, "")
}

async function rewriteIndexAssetPaths(outdir: string): Promise<void> {
  const indexPath = join(outdir, "index.html")
  const originalHtml = await readFile(indexPath, "utf-8")
  const html = restoreAppStaticUrls(originalHtml)

  const rewritten = html.replace(
    /(href|src)=(["'])((?!\/|#|[a-zA-Z][a-zA-Z\d+.-]*:)(?:\.\/)?[^"'?#]+(?:[?#][^"']*)?)\2/g,
    (_match, attr: string, quote: string, url: string) => {
      const normalized = url.startsWith("./") ? url.slice(2) : url
      return `${attr}=${quote}/${normalized}${quote}`
    }
  )

  if (rewritten !== originalHtml) {
    await writeFile(indexPath, rewritten, "utf-8")
  }
}
