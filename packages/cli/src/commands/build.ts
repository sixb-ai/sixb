import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { createCustomApp } from "@sixb/app/server"
import { buildRuntime } from "../lib/build-runtime"
import { generateProjectTypes } from "../lib/typegen"
import { buildView, errorView, renderStatic, withTask } from "../ui"

export interface BuildOptions {
  entry?: string
  outdir?: string
}

export async function runBuild(options: BuildOptions = {}) {
  const entry = resolve(options.entry ?? "sixb.config.ts")
  const outdir = resolve(options.outdir ?? ".sixb/dist")
  const projectRoot = dirname(entry)
  const startedAt = Date.now()

  const failure = await withTask("build", "Generating types", async (task) => {
    await generateProjectTypes({ entry })
    await mkdir(outdir, { recursive: true })

    task.step("Bundling runtime")
    const result = await buildRuntime(entry, outdir)
    if (!result.success) {
      return errorView({
        title: "Build failed",
        message: "Compilation errors",
        details: result.logs.map(String),
      })
    }

    task.step("Building app")
    const customApp = await createCustomApp({
      rootDir: projectRoot,
      // Keep production build inputs separate from the files watched by `sixb dev`.
      // Sharing `.sixb/generated` lets this command replace the dev app's injected
      // API origin and HTML bundle, causing Bun to hot-reload a same-origin client.
      generatedDir: join(".sixb", "build", "app"),
    })

    try {
      const appResult = await customApp.build({
        outdir: resolve(outdir, "app"),
      })
      if (!appResult.success) {
        return errorView({
          title: "App build failed",
          message: "Failed to build the app",
          details: appResult.logs ?? [],
        })
      }
    } catch (error) {
      // e.g. the app/globals.css Tailwind compile failed — surface the labeled
      // message instead of an unhandled stack trace.
      return errorView({
        title: "App build failed",
        message: "Failed to build the app",
        details: [error instanceof Error ? error.message : String(error)],
      })
    }
    return null
  })

  if (failure) {
    await renderStatic(failure)
    process.exit(1)
  }
  await renderStatic(buildView({ entry, outdir, seconds: (Date.now() - startedAt) / 1000 }))
}
