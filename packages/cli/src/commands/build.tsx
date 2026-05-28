import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { createCustomApp } from "@pario/app"
import { buildAtlasAssets } from "@pario/atlas"
import { buildSentinelAssets } from "@pario/sentinel"
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
    external: ["@pario/ducklake"],
  })

  if (!result.success) {
    const details = result.logs.map(String)
    await renderStatic(
      <ErrorView title="Build failed" message="Compilation errors" details={details} />
    )
    process.exit(1)
  }

  const customApp = await createCustomApp({
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

  try {
    await buildAtlasAssets({ outdir: resolve(outdir, "atlas") })
    await buildSentinelAssets({ outdir: resolve(outdir, "sentinel") })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(
      <ErrorView
        title="Built-in UI build failed"
        message="Failed to build production UI assets"
        details={[message]}
      />
    )
    process.exit(1)
  }

  await renderStatic(<BuildView entry={entry} outdir={outdir} />)
}
