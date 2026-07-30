import { access, mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { renderSixbBrowserRuntimeScript } from "@sixb/client/browser"
import type { AuthSessionAudience } from "@sixb/core"

export interface BuiltInUiBundle {
  outdir: string
  scriptPath: string
  stylesheetPath: string
}

export interface BuiltInUiBundleOptions {
  readonly outdir?: string
}

export interface BuiltInUiRuntimeConfig {
  readonly apiBaseUrl: string
  readonly audience: AuthSessionAudience
  readonly authEnabled: boolean
}

export interface BuiltInUiDevBundle {
  html: Bun.HTMLBundle
}

export interface BuiltInUiShellConfig extends BuiltInUiRuntimeConfig {
  readonly scriptPath: string
  readonly stylesheetPath: string
}

/**
 * How long the Atlas bundle build may take before it is killed and reported as failed. A healthy
 * build is under a second, so this is not a performance allowance — it is the line past which the
 * bundler is presumed stuck rather than slow.
 */
const BUNDLE_TIMEOUT_MS = 120_000

let readyBundle: Promise<BuiltInUiBundle> | null = null
const packageRoot = join(import.meta.dir, "..")
const sourceDir = join(packageRoot, "src")
const generatedDir = join(packageRoot, ".sixb")

export async function ensureBuiltInUiBundle(
  options: BuiltInUiBundleOptions = {}
): Promise<BuiltInUiBundle> {
  if (readyBundle) {
    return await readyBundle
  }

  readyBundle = buildBuiltInUiBundle(options)

  try {
    return await readyBundle
  } catch (error) {
    readyBundle = null
    throw error
  }
}

export async function ensureBuiltInUiDevBundle(): Promise<BuiltInUiDevBundle> {
  const htmlPath = join(sourceDir, "index.html")
  const htmlModule = (await import(htmlPath)) as { default: Bun.HTMLBundle }
  return { html: htmlModule.default }
}

export async function buildBuiltInUiBundle(
  options: BuiltInUiBundleOptions = {}
): Promise<BuiltInUiBundle> {
  const outdir = options.outdir ?? join(generatedDir, "browser")
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })

  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      join(sourceDir, "main.tsx"),
      "--outdir",
      outdir,
      "--target",
      "browser",
      // Resolve `@sixb/*` through the `bun` condition, which points at source. Without it a browser
      // target picks `import` and reads each package's `dist`, so this build silently depended on
      // whichever packages happened to be built already — the same dependency `packages/app` avoids
      // by passing `conditions: ["bun"]`. Atlas bundles its own copy of that source either way.
      "--conditions",
      "bun",
      // The entry gets a name no chunk can take. Bun names chunks after the source module they
      // come from, so with `[name]-[hash]` on both, `main.tsx` and its 47 shared chunks all
      // produced `main-*.js` and `findBuiltAsset` could not tell them apart. Prefixes make the
      // three kinds of output distinguishable by name alone.
      "--entry-naming",
      "atlas-[hash].[ext]",
      "--chunk-naming",
      "chunk-[name]-[hash].[ext]",
      "--asset-naming",
      "asset-[name]-[hash].[ext]",
      // React is bundled here rather than external, so without this the production Atlas bundle
      // ships React's development build: every render pays the dev-only checks and the browser
      // downloads them. `--production` sets NODE_ENV=production, which picks the production JSX
      // runtime, and minifies.
      "--production",
      // Moves everything behind a dynamic import out of the entry. Shiki's ~350 language grammars
      // are the bulk of Atlas: without this the browser downloads all 11.5 MB to render the first
      // page, with it 2.3 MB, and the grammars arrive only when a page highlights that language.
      // The shell loads the entry with `type="module"`, so the relative chunk imports Bun emits
      // resolve against the same served directory.
      "--splitting",
    ],
    {
      cwd: sourceDir,
      stdout: "ignore",
      stderr: "pipe",
    }
  )

  // Read stderr *while* the child runs. Reading only after `exited` leaves the pipe unread, and a
  // child that fills its buffer blocks on write while this waits for the exit that write prevents.
  const stderrText = new Response(proc.stderr).text()

  // The bundler can wedge — Bun's has deadlocked on hosted runners — and an unbounded wait turns
  // that into a caller that never returns: a `sixb build` with no output, or a CI job that dies at
  // its own wall clock naming nothing. Killing the child is as much the point as the timer: a child
  // left alive outlives this function and gets reaped as an orphan by whatever supervises the job.
  let timedOut = false
  const killTimer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, BUNDLE_TIMEOUT_MS)

  try {
    const exitCode = await proc.exited
    if (timedOut) {
      throw new Error(
        `[SixbAtlas] Built-in UI bundle did not finish within ${BUNDLE_TIMEOUT_MS}ms and was stopped.`
      )
    }
    if (exitCode !== 0) {
      throw new Error(
        `[SixbAtlas] Failed to build built-in UI bundle: ${(await stderrText).trim()}`
      )
    }
  } finally {
    clearTimeout(killTimer)
    // Settle the read either way, so a killed child leaves nothing pending.
    await stderrText.catch(() => "")
  }

  return await resolveBuiltInUiBundle(outdir)
}

export async function loadBuiltInUiBundle(
  options: BuiltInUiBundleOptions = {}
): Promise<BuiltInUiBundle> {
  const outdir = options.outdir ?? join(generatedDir, "browser")

  try {
    await access(outdir)
  } catch {
    throw new Error(
      `[SixbAtlas] Built Atlas UI assets are missing in ${outdir}. Run \`sixb build\` before serving Atlas in production.`
    )
  }

  return await resolveBuiltInUiBundle(outdir)
}

export function renderBuiltInUiShell(config: BuiltInUiShellConfig): string {
  const runtimeConfigScript = renderSixbBrowserRuntimeScript({
    api: { baseUrl: config.apiBaseUrl },
    auth: { audience: config.audience, enabled: config.authEnabled },
  })

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <base href="/" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#f6f7fb" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)" />
    <title>Sixb Atlas</title>
    <link rel="stylesheet" href="${config.stylesheetPath}" />
    ${runtimeConfigScript}
    <script type="module" src="${config.scriptPath}"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`
}

async function resolveBuiltInUiBundle(outdir: string): Promise<BuiltInUiBundle> {
  const files = await readdir(outdir)
  const scriptFile = findBuiltAsset(files, "atlas", "js")
  const stylesheetFile = findBuiltAsset(files, "atlas", "css")

  return {
    outdir,
    scriptPath: `/__sixb/${scriptFile}`,
    stylesheetPath: `/__sixb/${stylesheetFile}`,
  }
}

function findBuiltAsset(files: readonly string[], entryName: string, extension: string): string {
  const pattern = new RegExp(`^${escapeRegExp(entryName)}-[^.]+\\.${escapeRegExp(extension)}$`)
  const matches = files.filter((file) => pattern.test(file))

  if (matches.length !== 1) {
    throw new Error(
      `[SixbAtlas] Expected one ${entryName}.${extension} bundle in the built Atlas UI output, found ${matches.length}. Run \`sixb build\`.`
    )
  }

  return matches[0]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
