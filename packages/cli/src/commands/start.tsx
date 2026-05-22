import { stat } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { createParioApp } from "@pario/app"
import { createParioServer, type ParioServer } from "@pario/server"
import { type LoadedPario, loadParioFromEntry } from "../lib/loadPario"
import { runUntilSignal, startParioRuntime, stopQuietly } from "../lib/runtime"
import { ErrorView, LoadingView, renderPersistent, renderStatic, StartView } from "../ui"

export interface StartOptions {
  entry?: string
  port?: string
  appPort?: string
  host?: string
  publicOrigin?: string
  appPublicOrigin?: string
}

export async function runStart(options: StartOptions = {}) {
  process.env.NODE_ENV = "production"

  const sourceEntry = resolve("pario.config.ts")
  const defaultBuiltEntry = resolve(".pario/dist/pario.config.js")
  const port = options.port ? Number.parseInt(options.port, 10) : 3000
  const appPort = options.appPort ? Number.parseInt(options.appPort, 10) : port + 1
  const host = options.host ?? "0.0.0.0"

  let entry = sourceEntry
  if (options.entry) {
    entry = resolve(options.entry)
  } else {
    const builtInfo = await stat(defaultBuiltEntry).catch(() => null)
    entry = builtInfo ? defaultBuiltEntry : sourceEntry
  }

  const app = renderPersistent(
    <LoadingView title="Starting pario" subtitle={entry} status="Loading runtime" />
  )

  let server: ParioServer | null = null
  let customAppServer: ParioServer | null = null
  let pario: LoadedPario | null = null
  let runtime: Awaited<ReturnType<typeof startParioRuntime>> | null = null
  const warnings: string[] = []

  try {
    pario = await loadParioFromEntry(entry)
    runtime = await startParioRuntime(pario, { cohostWorkers: false })
    const projectRoot = resolveProjectRoot(entry)
    const displayHost = host === "0.0.0.0" ? "localhost" : host
    const baseUrl = `http://${displayHost}:${port}`

    server = createParioServer({
      pario,
      port,
      host,
      quiet: true,
      surface: { kind: "builtInUi" },
      publicOrigin: options.publicOrigin ?? process.env.PARIO_PUBLIC_ORIGIN,
    })
    await server.start()

    const appBaseUrl = `http://${displayHost}:${appPort}`
    const customApp = await createParioApp({
      rootDir: projectRoot,
    })
    const builtAppEntry = resolve(projectRoot, ".pario", "dist", "app", "index.html")
    const hasBuiltCustomApp = await stat(builtAppEntry)
      .then(() => true)
      .catch(() => false)

    let appUrl: string | null = null
    if (hasBuiltCustomApp) {
      if (appPort === port) {
        throw new Error("[ParioCLI] --app-port must be different from --port.")
      }

      customAppServer = createParioServer({
        pario,
        port: appPort,
        host,
        quiet: true,
        surface: {
          kind: "customApp",
          app: await customApp.createProductionMount({
            outdir: resolve(projectRoot, ".pario", "dist", "app"),
          }),
        },
        publicOrigin: options.appPublicOrigin ?? process.env.PARIO_APP_PUBLIC_ORIGIN,
      })
      await customAppServer.start()
      appUrl = appBaseUrl
    } else if (await customApp.hasRoutes()) {
      warnings.push(
        "Custom app source found, but no production build exists at .pario/dist/app. Run `pario build` first."
      )
    }

    app.rerender(
      <StartView
        name={pario.id}
        apiUrl={`${baseUrl}/api`}
        apiDocsUrl={`${baseUrl}/docs`}
        wsUrl={`${baseUrl.replace("http", "ws")}/ws/events`}
        uiUrl={baseUrl}
        appUrl={appUrl}
        warnings={warnings}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down...")
      await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
      await stopQuietly(() => server?.stop() ?? Promise.resolve())
      await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
    await stopQuietly(() => server?.stop() ?? Promise.resolve())
    await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}

function resolveProjectRoot(entry: string): string {
  const resolvedEntry = resolve(entry)
  const distMarker = `${sep}.pario${sep}dist${sep}`
  const distIndex = resolvedEntry.lastIndexOf(distMarker)

  if (distIndex >= 0) {
    return resolvedEntry.slice(0, distIndex)
  }

  return dirname(resolvedEntry)
}
