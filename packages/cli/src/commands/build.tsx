import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { createCustomApp } from "@sixb/app"
import { buildAtlasAssets } from "@sixb/atlas"
import { generateProjectTypes } from "../lib/typegen"
import { BuildView, ErrorView, renderStatic } from "../ui"

export interface BuildOptions {
  entry?: string
  outdir?: string
}

export async function runBuild(options: BuildOptions = {}) {
  const entry = resolve(options.entry ?? "sixb.config.ts")
  const outdir = resolve(options.outdir ?? ".sixb/dist")
  const projectRoot = dirname(entry)

  await generateProjectTypes({ entry })
  await mkdir(outdir, { recursive: true })

  // Build sixb.config.ts
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "bun",
    sourcemap: "external",
    minify: false,
    packages: "external",
    external: ["@sixb/*"],
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
    try {
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
    } catch (error) {
      // e.g. the app/globals.css Tailwind compile failed — surface the labeled
      // message instead of an unhandled stack trace.
      const message = error instanceof Error ? error.message : String(error)
      await renderStatic(
        <ErrorView title="App build failed" message="Failed to build the app" details={[message]} />
      )
      process.exit(1)
    }
  }

  try {
    await buildAtlasAssets({ outdir: resolve(outdir, "atlas") })
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
