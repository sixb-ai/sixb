import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join, resolve } from "node:path"
import { promisify } from "node:util"
import {
  brotliCompress as brotliCompressCallback,
  gzip as gzipCallback,
  constants as zlibConstants,
} from "node:zlib"

const STATIC_ASSET_ORIGIN = "https://sixb-static.invalid"
const brotliCompress = promisify(brotliCompressCallback)
const gzip = promisify(gzipCallback)
const PRECOMPRESSION_CONCURRENCY = 4

export interface BuildAppOptions {
  /** Path to the generated index.html entry point */
  entryPath: string
  /** Browser TypeScript entry generated alongside `entryPath`. */
  scriptEntryPath: string
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
 * Builds the generated browser entry and writes a production-ready static shell and bundle.
 */
export async function buildApp(options: BuildAppOptions): Promise<BuildAppResult> {
  const outdir = options.outdir ?? join(process.cwd(), ".sixb", "dist", "app")
  // The outdir is build-owned. Clear it so hashed chunks from previous builds
  // don't accumulate (and get served) forever.
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })

  const result = await Bun.build({
    // Build the script entry directly rather than Bun's HTML entry. Bun cannot currently preserve
    // a large dynamic-import graph reliably when splitting an HTML entry: one of the lazy chunks
    // can be written into the shell's script tag. Building TypeScript directly also lets Shiki's
    // hundreds of grammars remain off the initial custom-app path.
    entrypoints: [options.scriptEntryPath],
    outdir,
    target: "browser",
    conditions: ["bun"],
    publicPath: "/",
    minify: true,
    splitting: true,
    naming: {
      entry: "app-[hash].[ext]",
      chunk: "chunk-[name]-[hash].[ext]",
      asset: "asset-[name]-[hash].[ext]",
    },
    plugins: [extensionlessSourceImportPlugin],
    // React is bundled into this browser output, so without pinning NODE_ENV the production build
    // of a user's app ships React's development build: dev-only checks on every render, and the
    // warnings that go with them. This is also the only knob that selects the production JSX
    // runtime — an ambient NODE_ENV does not.
    define: { "process.env.NODE_ENV": '"production"' },
    sourcemap: "external",
  })

  if (!result.success) {
    return {
      success: false,
      outdir,
      logs: result.logs.map(String),
    }
  }

  const script = result.outputs.find(
    (output) => output.kind === "entry-point" && output.type.startsWith("text/javascript")
  )
  const stylesheets = result.outputs.filter((output) => output.type.startsWith("text/css"))
  if (!script || stylesheets.length > 1) {
    throw new Error(
      `[SixbCustomApp] Expected one browser entry and at most one stylesheet, found ${script ? 1 : 0} entries and ${stylesheets.length} stylesheets.`
    )
  }

  const sourceHtml = restoreAppStaticUrls(await readFile(options.entryPath, "utf-8"))
  const sourceEntryPattern =
    /\s*<script\s+type=["']module["']\s+src=["']\.\/main\.tsx["']><\/script>/
  if (!sourceEntryPattern.test(sourceHtml)) {
    throw new Error("[SixbCustomApp] Generated app shell is missing its ./main.tsx entry.")
  }

  const assetTags = [
    ...stylesheets.map(
      (stylesheet) => `<link rel="stylesheet" crossorigin href="/${basename(stylesheet.path)}">`
    ),
    `<script type="module" crossorigin src="/${basename(script.path)}"></script>`,
  ].join("")
  const html = withLoadingShell(sourceHtml)
    .replace(sourceEntryPattern, "")
    .replace("</head>", `  ${assetTags}</head>`)
  await writeFile(join(outdir, "index.html"), html, "utf-8")

  if (options.manifestPath) {
    await copyFile(options.manifestPath, join(outdir, "app.webmanifest"))
  }
  await precompressBuildAssets(result.outputs)

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

function withLoadingShell(html: string): string {
  const styles = `<style data-sixb-loading-shell>
      .sixb-loading-shell{position:fixed;inset:0;display:grid;place-items:center;background:#fff;color:#71717a}
      .sixb-loading-spinner{width:1.25rem;height:1.25rem;border:2px solid currentColor;border-right-color:transparent;border-radius:9999px;animation:sixb-loading-spin .7s linear infinite}
      @media(prefers-color-scheme:dark){.sixb-loading-shell{background:#09090b;color:#a1a1aa}}
      @media(prefers-reduced-motion:reduce){.sixb-loading-spinner{animation-duration:1.5s}}
      @keyframes sixb-loading-spin{to{transform:rotate(360deg)}}
    </style>`
  const root =
    '<div id="root"><div class="sixb-loading-shell" role="status" aria-label="Loading application"><span class="sixb-loading-spinner" aria-hidden="true"></span></div></div>'

  if (!html.includes('<div id="root"></div>') || !html.includes("</head>")) {
    throw new Error("[SixbCustomApp] Generated app shell is missing its root or head element.")
  }

  return html.replace("</head>", `${styles}\n  </head>`).replace('<div id="root"></div>', root)
}

const extensionlessSourceImportPlugin: Bun.BunPlugin = {
  name: "sixb-extensionless-source-imports",
  setup(build) {
    // A direct TypeScript entry with splitting exposes a Bun 1.3 resolver edge in linked workspace
    // packages: extensionless relative imports such as `../json` can fail even though `json.ts`
    // exists. HTML entries masked it, but HTML splitting can point at the wrong dynamic chunk.
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (extname(args.path)) return undefined

      const base = resolve(dirname(args.importer), args.path)
      for (const candidate of [
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.jsx`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
        join(base, "index.js"),
        join(base, "index.jsx"),
      ]) {
        if (existsSync(candidate)) return { path: candidate }
      }

      return undefined
    })
  },
}

async function precompressBuildAssets(
  outputs: readonly { readonly path: string; readonly type: string }[]
): Promise<void> {
  const paths = outputs
    .filter(
      (output) => output.type.startsWith("text/javascript") || output.type.startsWith("text/css")
    )
    .map((output) => output.path)
  let cursor = 0

  const worker = async () => {
    while (cursor < paths.length) {
      const path = paths[cursor++]
      const bytes = await Bun.file(path).arrayBuffer()
      const [brotli, gzipped] = await Promise.all([
        brotliCompress(bytes, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
          },
        }),
        gzip(bytes, { level: 9 }),
      ])
      await Promise.all([writeFile(`${path}.br`, brotli), writeFile(`${path}.gz`, gzipped)])
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PRECOMPRESSION_CONCURRENCY, paths.length) }, worker)
  )
}
