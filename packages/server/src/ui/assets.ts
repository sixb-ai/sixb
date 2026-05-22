import { mkdir } from "node:fs/promises"
import { join } from "node:path"

export interface BuiltInUiBundle {
  outdir: string
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
      "[name].[ext]",
      "--asset-naming",
      "[name].[ext]",
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
    throw new Error(`[ParioServer] Failed to build built-in UI bundle: ${stderr.trim()}`)
  }

  return { outdir }
}

export function renderBuiltInUiShell(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <base href="/" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#f6f7fb" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)" />
    <title>Pario</title>
    <link rel="stylesheet" href="/__pario/main.css" />
    <script type="module" src="/__pario/main.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`
}
