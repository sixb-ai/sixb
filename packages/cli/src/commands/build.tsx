import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { createParioApp } from "@pario/app"
import { BuildView, ErrorView, renderStatic } from "../ui"

export interface BuildOptions {
  entry?: string
  outdir?: string
}

export async function runBuild(options: BuildOptions = {}) {
  const entry = resolve(options.entry ?? "pario.config.ts")
  const outdir = resolve(options.outdir ?? ".pario/dist")
  const projectRoot = dirname(entry)

  await mkdir(outdir, { recursive: true })

  // Build pario.config.ts
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "bun",
    sourcemap: "external",
    minify: false,
  })

  if (!result.success) {
    const details = result.logs.map(String)
    await renderStatic(
      <ErrorView title="Build failed" message="Compilation errors" details={details} />
    )
    process.exit(1)
  }

  const customApp = await createParioApp({
    rootDir: projectRoot,
  })

  if (await customApp.hasRoutes()) {
    const appResult = await customApp.build({
      outdir: resolve(outdir, "app"),
    })

    if (!appResult.success) {
      await renderStatic(
        <ErrorView
          title="App build failed"
          message="Failed to build the app"
          details={appResult.logs ?? []}
        />
      )
      process.exit(1)
    }
  }

  await renderStatic(<BuildView entry={entry} outdir={outdir} />)
}
