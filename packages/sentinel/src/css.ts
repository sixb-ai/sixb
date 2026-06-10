import { watch } from "node:fs"
import { join } from "node:path"
import { createTailwindCssCompiler, type TailwindCssCompiler } from "@sixb/app"

export interface BuiltInUiCssHandle {
  stop(): Promise<void>
}

const packageRoot = join(import.meta.dir, "..")
const sourceDir = join(packageRoot, "src")
const generatedDir = join(packageRoot, ".sixb")
const LABEL = "[SixbSentinel]"

let defaultCompiler: TailwindCssCompiler | null = null

export interface BuiltInUiCssOptions {
  readonly watch?: boolean
}

export async function ensureBuiltInUiCss(
  options: BuiltInUiCssOptions = {}
): Promise<BuiltInUiCssHandle> {
  const compiler = getDefaultCompiler()
  await compiler.compile()

  let watcher: ReturnType<typeof watch> | null = null

  if (options.watch) {
    watcher = watch(sourceDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return
      if (!/\.(css|ts|tsx)$/.test(filename)) return
      compiler.schedule()
    })
  }

  return {
    async stop() {
      watcher?.close()
      await compiler.stop()
    },
  }
}

export async function buildBuiltInUiCss(inputPath?: string, outputPath?: string): Promise<void> {
  if (!inputPath && !outputPath) {
    await getDefaultCompiler().compile()
    return
  }

  await createTailwindCssCompiler({
    inputPath: inputPath ?? join(sourceDir, "index.css"),
    outputPath: outputPath ?? join(generatedDir, "ui.css"),
    cwd: sourceDir,
    resolveFrom: packageRoot,
    label: LABEL,
  }).compile()
}

function getDefaultCompiler(): TailwindCssCompiler {
  defaultCompiler ??= createTailwindCssCompiler({
    inputPath: join(sourceDir, "index.css"),
    outputPath: join(generatedDir, "ui.css"),
    cwd: sourceDir,
    resolveFrom: packageRoot,
    label: LABEL,
  })

  return defaultCompiler
}
