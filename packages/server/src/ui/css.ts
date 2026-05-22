import { watch } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export interface BuiltInUiCssHandle {
  stop(): Promise<void>
}

let activeCssBuild: Promise<void> | null = null
let tailwindCliEntryPromise: Promise<string> | null = null

export async function ensureBuiltInUiCss(
  options: { watch?: boolean } = {}
): Promise<BuiltInUiCssHandle> {
  const inputPath = join(import.meta.dir, "src", "index.css")
  const outputPath = join(import.meta.dir, ".pario", "ui.css")

  await mkdir(dirname(outputPath), { recursive: true })
  await buildBuiltInUiCss(inputPath, outputPath)

  let closed = false
  let watcher: ReturnType<typeof watch> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let building: Promise<void> | null = null
  let rebuildRequested = false

  if (options.watch) {
    const scheduleBuild = () => {
      if (closed) return
      if (timer) {
        clearTimeout(timer)
      }

      timer = setTimeout(() => {
        timer = null
        void runBuild()
      }, 50)
    }

    const runBuild = async () => {
      if (building) {
        rebuildRequested = true
        return
      }

      building = buildBuiltInUiCss(inputPath, outputPath)
      try {
        await building
      } finally {
        building = null
        if (rebuildRequested) {
          rebuildRequested = false
          await runBuild()
        }
      }
    }

    watcher = watch(join(import.meta.dir, "src"), { recursive: true }, (_eventType, filename) => {
      if (!filename) return
      if (!/\.(css|ts|tsx)$/.test(filename)) return
      scheduleBuild()
    })
  }

  return {
    async stop() {
      closed = true
      if (timer) {
        clearTimeout(timer)
      }
      watcher?.close()
      if (building) {
        await building.catch(() => {})
      }
    },
  }
}

async function buildBuiltInUiCss(inputPath: string, outputPath: string): Promise<void> {
  if (activeCssBuild) {
    await activeCssBuild
    return
  }

  activeCssBuild = (async () => {
    const proc = Bun.spawn(
      [process.execPath, await resolveTailwindCliEntry(), "-i", inputPath, "-o", outputPath],
      {
        cwd: import.meta.dir,
        stdout: "ignore",
        stderr: "pipe",
      }
    )

    const exitCode = await proc.exited
    if (exitCode === 0) {
      return
    }

    const stderr = await new Response(proc.stderr).text()
    throw new Error(`[ParioServer] Failed to build built-in UI CSS: ${stderr.trim()}`)
  })()

  try {
    await activeCssBuild
  } finally {
    activeCssBuild = null
  }
}

async function resolveTailwindCliEntry(): Promise<string> {
  tailwindCliEntryPromise ??= Promise.resolve(
    join(
      dirname(fileURLToPath(import.meta.resolve("@tailwindcss/cli/package.json"))),
      "dist",
      "index.mjs"
    )
  )

  return await tailwindCliEntryPromise
}
