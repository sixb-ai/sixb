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
export const SHARED_APP_SHELL_FILE_NAME = "shared-index.html"

export interface BuildAppOptions {
  /** Path to the generated index.html entry point */
  entryPath: string
  /** Browser TypeScript entry generated alongside `entryPath`. */
  scriptEntryPath: string
  /** Isolated shared-link HTML shell. Must be paired with `sharedScriptEntryPath`. */
  sharedEntryPath?: string
  /** Browser TypeScript entry loaded by the shared-link shell. */
  sharedScriptEntryPath?: string
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

export interface BuildSharedAppDevResult {
  readonly assetPaths: readonly string[]
  readonly html: string
}

export interface BuildAuthExperienceOptions {
  /** Generated HTML shell containing the auth bootstrap placeholder. */
  entryPath: string
  /** Browser TypeScript entry generated alongside `entryPath`. */
  scriptEntryPath: string
  /** Directory written for the API server to mount under `/auth`. */
  outdir: string
}

/**
 * Builds the generated browser entry and writes a production-ready static shell and bundle.
 */
export async function buildApp(options: BuildAppOptions): Promise<BuildAppResult> {
  const outdir = options.outdir ?? join(process.cwd(), ".sixb", "dist", "app")
  if (Boolean(options.sharedEntryPath) !== Boolean(options.sharedScriptEntryPath)) {
    throw new Error(
      "[SixbCustomApp] sharedEntryPath and sharedScriptEntryPath must be provided together."
    )
  }

  // The outdir is build-owned. Clear it so hashed chunks from previous builds
  // don't accumulate (and get served) forever.
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })

  const result = await buildBrowserEntry(options.scriptEntryPath, outdir, "app")

  if (!result.success) {
    return {
      success: false,
      outdir,
      logs: result.logs.map(String),
    }
  }

  const normalEntry = resolveBrowserEntry(result.outputs, "browser")
  const sourceHtml = restoreAppStaticUrls(await readFile(options.entryPath, "utf-8"))
  const sourceEntryPattern =
    /\s*<script\s+type=["']module["']\s+src=["']\.\/main\.tsx["']><\/script>/
  if (!sourceEntryPattern.test(sourceHtml)) {
    throw new Error("[SixbCustomApp] Generated app shell is missing its ./main.tsx entry.")
  }

  const assetTags = [
    ...normalEntry.stylesheets.map(
      (stylesheet) => `<link rel="stylesheet" crossorigin href="/${basename(stylesheet.path)}">`
    ),
    `<script type="module" crossorigin src="/${basename(normalEntry.script.path)}"></script>`,
  ].join("")
  const html = withLoadingShell(sourceHtml)
    .replace(sourceEntryPattern, "")
    .replace("</head>", `  ${assetTags}</head>`)
  await writeFile(join(outdir, "index.html"), html, "utf-8")

  const outputs = [...result.outputs]
  if (options.sharedEntryPath && options.sharedScriptEntryPath) {
    // Keep these builds sequential. Bun can mis-resolve package-relative imports when two large
    // browser entry graphs are built together, while content hashes safely deduplicate their
    // shared chunks in one output directory.
    const sharedResult = await buildBrowserEntry(options.sharedScriptEntryPath, outdir, "shared")
    if (!sharedResult.success) {
      return {
        success: false,
        outdir,
        logs: sharedResult.logs.map(String),
      }
    }

    const sharedEntry = resolveBrowserEntry(sharedResult.outputs, "shared browser")
    const sharedHtml = await renderSharedAppHtml(options.sharedEntryPath, sharedEntry)
    await writeFile(join(outdir, SHARED_APP_SHELL_FILE_NAME), sharedHtml, "utf-8")
    outputs.push(...sharedResult.outputs)
  }

  if (options.manifestPath) {
    await copyFile(options.manifestPath, join(outdir, "app.webmanifest"))
  }
  await precompressBuildAssets(outputs)

  return { success: true, outdir }
}

/**
 * Builds the shared shell like production for development, without Bun's HTML/HMR transform.
 * Bun 1.3 injects a script before an inline loader, which would execute application code while the
 * share secret is still in the document URL. The ordinary app keeps HTML-bundle HMR.
 */
export async function buildSharedAppDev(options: {
  readonly entryPath: string
  readonly outdir: string
  readonly scriptEntryPath: string
}): Promise<BuildSharedAppDevResult> {
  await rm(options.outdir, { recursive: true, force: true })
  await mkdir(options.outdir, { recursive: true })

  let result: Bun.BuildOutput
  try {
    result = await buildBrowserEntry(options.scriptEntryPath, options.outdir, "shared-dev", true)
  } catch (error) {
    await rm(options.outdir, { recursive: true, force: true })
    throw error
  }
  if (!result.success) {
    await rm(options.outdir, { recursive: true, force: true })
    throw new Error(
      `[SixbCustomApp] Failed to build the shared development shell: ${result.logs.map(String).join("\n")}`
    )
  }

  const entry = resolveBrowserEntry(result.outputs, "shared development browser")
  return {
    assetPaths: result.outputs.map((output) => output.path),
    html: await renderSharedAppHtml(options.entryPath, entry),
  }
}

async function buildBrowserEntry(
  entrypoint: string,
  outdir: string,
  entryName: "app" | "shared" | "shared-dev",
  development = false
): Promise<Bun.BuildOutput> {
  return await Bun.build({
    // Build the script entry directly rather than Bun's HTML entry. Bun cannot currently preserve
    // a large dynamic-import graph reliably when splitting an HTML entry: one of the lazy chunks
    // can be written into the shell's script tag. Building TypeScript directly also lets Shiki's
    // hundreds of grammars remain off the initial custom-app path.
    entrypoints: [entrypoint],
    outdir,
    target: "browser",
    conditions: ["bun"],
    publicPath: "/",
    minify: !development,
    splitting: true,
    naming: {
      entry: `${entryName}-[hash].[ext]`,
      chunk: "chunk-[name]-[hash].[ext]",
      asset: "asset-[name]-[hash].[ext]",
    },
    plugins: [extensionlessSourceImportPlugin],
    // React is bundled into this browser output, so without pinning NODE_ENV the production build
    // of a user's app ships React's development build: dev-only checks on every render, and the
    // warnings that go with them. This is also the only knob that selects the production JSX
    // runtime — an ambient NODE_ENV does not.
    define: { "process.env.NODE_ENV": development ? '"development"' : '"production"' },
    sourcemap: development ? "inline" : "external",
  })
}

async function renderSharedAppHtml(
  entryPath: string,
  entry: {
    readonly script: Bun.BuildArtifact
    readonly stylesheets: readonly Bun.BuildArtifact[]
  }
): Promise<string> {
  const sourceHtml = restoreAppStaticUrls(await readFile(entryPath, "utf-8"))
  const sourceEntryPattern =
    /const \{ startSharedApp \} = await import\((["'])\.\/shared-main\.tsx\1\)\s+startSharedApp\(bootstrap\)/
  if (!sourceEntryPattern.test(sourceHtml)) {
    throw new Error(
      "[SixbCustomApp] Generated shared app shell is missing its ./shared-main.tsx import."
    )
  }

  // The share secret initially lives in location.hash. Static scripts, stylesheets, and preloads
  // are forbidden. The inline loader removes the fragment, imports the authority bootstrap, then
  // that bootstrap invokes loadAppStyles only after session establishment and canonicalization.
  const stylesheetUrls = entry.stylesheets.map((stylesheet) => `/${basename(stylesheet.path)}`)
  const bootstrap = [
    `const { startSharedApp } = await import(${JSON.stringify(`/${basename(entry.script.path)}`)})`,
    ...(stylesheetUrls.length > 0
      ? [
          "          startSharedApp(bootstrap, {",
          "            async loadAppStyles() {",
          "              await Promise.all(",
          `                ${JSON.stringify(stylesheetUrls)}.map((href) => new Promise((resolve) => {`,
          '                  const link = document.createElement("link")',
          '                  link.rel = "stylesheet"',
          '                  link.crossOrigin = "anonymous"',
          '                  link.addEventListener("load", resolve, { once: true })',
          '                  link.addEventListener("error", resolve, { once: true })',
          "                  link.href = href",
          "                  document.head.append(link)",
          "                }))",
          "              )",
          "            },",
          "          })",
        ]
      : ["          startSharedApp(bootstrap)"]),
  ].join("\n")

  return withLoadingShell(sourceHtml).replace(sourceEntryPattern, bootstrap)
}

function resolveBrowserEntry(
  outputs: readonly Bun.BuildArtifact[],
  label: string
): {
  readonly script: Bun.BuildArtifact
  readonly stylesheets: readonly Bun.BuildArtifact[]
} {
  const script = outputs.find(
    (output) => output.kind === "entry-point" && output.type.startsWith("text/javascript")
  )
  const stylesheets = outputs.filter((output) => output.type.startsWith("text/css"))
  if (!script || stylesheets.length > 1) {
    throw new Error(
      `[SixbCustomApp] Expected one ${label} entry and at most one stylesheet, found ${script ? 1 : 0} entries and ${stylesheets.length} stylesheets.`
    )
  }
  return { script, stylesheets }
}

/** Builds the optional custom auth entry as API-served static assets. */
export async function buildAuthExperience(
  options: BuildAuthExperienceOptions
): Promise<BuildAppResult> {
  const outdir = resolve(options.outdir)
  const assetsDir = join(outdir, "assets")
  await rm(outdir, { recursive: true, force: true })
  await mkdir(assetsDir, { recursive: true })

  const result = await Bun.build({
    entrypoints: [options.scriptEntryPath],
    outdir: assetsDir,
    target: "browser",
    conditions: ["bun"],
    publicPath: "/auth/assets/",
    minify: true,
    splitting: true,
    naming: {
      entry: "auth-[hash].[ext]",
      chunk: "chunk-[name]-[hash].[ext]",
      asset: "asset-[name]-[hash].[ext]",
    },
    plugins: [extensionlessSourceImportPlugin],
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
      `[SixbCustomApp] Expected one auth entry and at most one stylesheet, found ${script ? 1 : 0} entries and ${stylesheets.length} stylesheets.`
    )
  }

  const sourceHtml = await readFile(options.entryPath, "utf-8")
  const sourceEntryPattern =
    /\s*<script\s+type=["']module["']\s+src=["']\.\/auth-main\.tsx["']><\/script>/
  if (!sourceEntryPattern.test(sourceHtml)) {
    throw new Error("[SixbCustomApp] Generated auth shell is missing its ./auth-main.tsx entry.")
  }

  const assetTags = [
    ...stylesheets.map(
      (stylesheet) =>
        `<link rel="stylesheet" crossorigin href="/auth/assets/${basename(stylesheet.path)}">`
    ),
    `<script type="module" crossorigin src="/auth/assets/${basename(script.path)}"></script>`,
  ].join("")
  const html = sourceHtml
    .replace(sourceEntryPattern, "")
    .replace("</head>", `  ${assetTags}</head>`)
  await writeFile(join(outdir, "index.html"), html, "utf-8")
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
  const entryName = basename(entryPath, ".html")
  const bundleEntryPath = join(dirname(entryPath), `${entryName}.sixb-bundle.html`)
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
  const paths = [
    ...new Set(
      outputs
        .filter(
          (output) =>
            output.type.startsWith("text/javascript") || output.type.startsWith("text/css")
        )
        .map((output) => output.path)
    ),
  ]
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
