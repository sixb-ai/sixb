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
      "--entry-naming",
      "[name]-[hash].[ext]",
      "--chunk-naming",
      "[name]-[hash].[ext]",
      "--asset-naming",
      "[name]-[hash].[ext]",
      // React is bundled here rather than external, so without this the production Atlas bundle
      // ships React's development build: every render pays the dev-only checks and the browser
      // downloads them. `--production` sets NODE_ENV=production, which picks the production JSX
      // runtime, and minifies.
      "--production",
    ],
    {
      cwd: sourceDir,
      stdout: "ignore",
      stderr: "pipe",
    }
  )

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`[SixbAtlas] Failed to build built-in UI bundle: ${stderr.trim()}`)
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
  const scriptFile = findBuiltAsset(files, "main", "js")
  const stylesheetFile = findBuiltAsset(files, "main", "css")

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
