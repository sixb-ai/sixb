import { mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { renderParioBrowserRuntimeScript } from "@pario/client/browser"
import type { AuthSessionAudience } from "@pario/core"

export interface BuiltInUiBundle {
  outdir: string
  scriptPath: string
  stylesheetPath: string
}

export interface BuiltInUiRuntimeConfig {
  readonly apiBaseUrl: string
  readonly audience: AuthSessionAudience
  readonly authEnabled: boolean
  readonly scriptPath: string
  readonly stylesheetPath: string
}

let readyBundle: Promise<BuiltInUiBundle> | null = null

export async function ensureBuiltInUiBundle(): Promise<BuiltInUiBundle> {
  if (readyBundle) {
    return await readyBundle
  }

  readyBundle = buildBuiltInUiBundle()

  try {
    return await readyBundle
  } catch (error) {
    readyBundle = null
    throw error
  }
}

async function buildBuiltInUiBundle(): Promise<BuiltInUiBundle> {
  const outdir = join(import.meta.dir, ".pario", "browser")
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })

  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      join(import.meta.dir, "src", "main.tsx"),
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
    ],
    {
      cwd: import.meta.dir,
      stdout: "ignore",
      stderr: "pipe",
    }
  )

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`[ParioSentinel] Failed to build built-in UI bundle: ${stderr.trim()}`)
  }

  const files = await readdir(outdir)
  const scriptFile = findBuiltAsset(files, "main", "js")
  const stylesheetFile = findBuiltAsset(files, "main", "css")

  return {
    outdir,
    scriptPath: `/__pario/${scriptFile}`,
    stylesheetPath: `/__pario/${stylesheetFile}`,
  }
}

export function renderBuiltInUiShell(config: BuiltInUiRuntimeConfig): string {
  const runtimeConfigScript = renderParioBrowserRuntimeScript({
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
    <meta name="theme-color" content="#f8fafc" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#020617" media="(prefers-color-scheme: dark)" />
    <title>Pario Sentinel</title>
    <link rel="stylesheet" href="${config.stylesheetPath}" />
    ${runtimeConfigScript}
    <script type="module" src="${config.scriptPath}"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`
}

function findBuiltAsset(files: readonly string[], entryName: string, extension: string): string {
  const pattern = new RegExp(`^${escapeRegExp(entryName)}-[^.]+\\.${escapeRegExp(extension)}$`)
  const matches = files.filter((file) => pattern.test(file))

  if (matches.length !== 1) {
    throw new Error(
      `[ParioSentinel] Expected one ${entryName}.${extension} bundle in the built UI output, found ${matches.length}.`
    )
  }

  return matches[0]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
