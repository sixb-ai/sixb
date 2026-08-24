import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

const STATIC_ASSET_ORIGIN = "https://sixb-static.invalid"
export const SHARED_APP_SHELL_FILE_NAME = "shared-index.html"

export interface BuildAppOptions {
  /** Path to the generated index.html entry point */
  entryPath: string
  /** Optional isolated shared-link HTML entry point. */
  sharedEntryPath?: string
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

  const entries = [
    {
      bundlePath: await prepareAppHtmlBundleEntry(options.entryPath),
      outputName: "index.html",
    },
    ...(options.sharedEntryPath
      ? [
          {
            bundlePath: await prepareAppHtmlBundleEntry(options.sharedEntryPath),
            outputName: SHARED_APP_SHELL_FILE_NAME,
          },
        ]
      : []),
  ]
  const failedLogs: string[] = []
  let buildFailed = false
  try {
    // Build the two HTML entries independently. Bun currently mis-resolves some
    // package-relative imports when separate HTML graphs share one build call;
    // sequential builds still share content-hashed assets safely in one outdir.
    for (const entry of entries) {
      const result = await Bun.build({
        entrypoints: [entry.bundlePath],
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
      if (!result.success) {
        buildFailed = true
        failedLogs.push(...result.logs.map(String))
        break
      }
      await rename(join(outdir, basename(entry.bundlePath)), join(outdir, entry.outputName))
    }
  } finally {
    await Promise.all(entries.map((entry) => rm(entry.bundlePath, { force: true })))
  }

  if (buildFailed) {
    return {
      success: false,
      outdir,
      logs: failedLogs,
    }
  }

  for (const entry of entries) {
    await rewriteHtmlAssetPaths(outdir, entry.outputName)
  }
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
  const entryName = basename(entryPath, ".html")
  const bundleEntryPath = join(dirname(entryPath), `${entryName}.sixb-bundle.html`)
  await writeFile(bundleEntryPath, bundleHtml, "utf-8")
  return bundleEntryPath
}

export function restoreAppStaticUrls(html: string): string {
  return html.replaceAll(STATIC_ASSET_ORIGIN, "")
}

async function rewriteHtmlAssetPaths(outdir: string, fileName: string): Promise<void> {
  const indexPath = join(outdir, fileName)
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
