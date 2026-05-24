import { dirname, resolve } from "node:path"
import { type CustomAppDevServer, createCustomApp } from "@pario/app"
import { type AtlasAppServer, createAtlasApp } from "@pario/atlas"
import { createParioServer, type ParioServer } from "@pario/server"
import { apiDocsUrl, apiEventsUrl, apiUrl, resolveBrowserTopology } from "../lib/browser-topology"
import { type LoadedPario, loadParioFromEntry } from "../lib/loadPario"
import { runUntilSignal, startParioRuntime, stopQuietly } from "../lib/runtime"
import { DevView, ErrorView, LoadingView, renderPersistent, renderStatic } from "../ui"

export interface DevOptions {
  entry?: string
  port?: string
  host?: string
  apiPort?: string
  apiHost?: string
  apiPublicOrigin?: string
  atlasPublicOrigin?: string
  appPublicOrigin?: string
}

export async function runDev(options: DevOptions = {}) {
  process.env.NODE_ENV = "development"

  const entry = resolve(options.entry ?? "pario.config.ts")
  const host = options.host ?? "0.0.0.0"

  const app = renderPersistent(
    <LoadingView title="Starting pario" subtitle={entry} status="Loading runtime" />
  )

  let server: ParioServer | null = null
  let atlasServer: AtlasAppServer | null = null
  let customAppServer: CustomAppDevServer | null = null
  let pario: LoadedPario | null = null
  let runtime: Awaited<ReturnType<typeof startParioRuntime>> | null = null

  try {
    pario = await loadParioFromEntry(entry)
    const projectRoot = dirname(resolve(entry))

    runtime = await startParioRuntime(pario, { cohostWorkers: true })

    app.rerender(<LoadingView title="Starting pario" subtitle={entry} status="Starting server" />)

    const customAppProbe = await createCustomApp({ rootDir: projectRoot })
    const hasCustomApp = await customAppProbe.hasRoutes()
    const topology = resolveBrowserTopology({
      mode: "development",
      host,
      apiHost: options.apiHost,
      port: options.port,
      apiPort: options.apiPort,
      apiPublicOrigin: options.apiPublicOrigin,
      atlasPublicOrigin: options.atlasPublicOrigin,
      appPublicOrigin: options.appPublicOrigin,
      includeCustomApp: hasCustomApp,
    })

    server = createParioServer({
      pario: pario as unknown as never,
      port: topology.apiPort,
      host: topology.apiHost,
      quiet: true,
      browser: {
        publicOrigin: topology.apiPublicOrigin,
        allowedOrigins: topology.allowedBrowserOrigins,
      },
    })
    await server.start()

    const atlas = createAtlasApp({
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "atlas",
    })
    atlasServer = await atlas.start({
      host: topology.host,
      port: topology.atlasPort,
      development: true,
    })

    const customApp = await createCustomApp({
      rootDir: projectRoot,
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "app",
    })

    let appUrl: string | null = null
    if (hasCustomApp) {
      app.rerender(
        <LoadingView title="Starting pario" subtitle={entry} status="Starting custom app" />
      )

      customAppServer = await customApp.dev({
        host: topology.host,
        port: topology.appPort,
      })
      appUrl = topology.appPublicOrigin
    }

    app.rerender(
      <DevView
        name={pario.id}
        apiUrl={apiUrl(topology)}
        apiDocsUrl={apiDocsUrl(topology)}
        wsUrl={apiEventsUrl(topology)}
        uiUrl={topology.atlasPublicOrigin}
        uiStatus={null}
        appUrl={appUrl}
        mqttUrl={null}
        warnings={runtime.warnings}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down...")
      await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
      await stopQuietly(() => atlasServer?.stop() ?? Promise.resolve())
      await stopQuietly(() => server?.stop() ?? Promise.resolve())
      await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
    await stopQuietly(() => atlasServer?.stop() ?? Promise.resolve())
    await stopQuietly(() => server?.stop() ?? Promise.resolve())
    await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
