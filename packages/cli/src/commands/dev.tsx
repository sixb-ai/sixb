import { dirname, resolve } from "node:path"
import { type CustomAppDevServer, createCustomApp } from "@sixb/app"
import { type AtlasAppServer, createAtlasApp } from "@sixb/atlas"
import { createSixbServer, type SixbServer } from "@sixb/server"
import { apiDocsUrl, apiEventsUrl, apiUrl, resolveBrowserTopology } from "../lib/browser-topology"
import { type LoadedSixb, loadSixbFromEntry } from "../lib/loadSixb"
import { runUntilSignal, startSixbRuntime, stopQuietly } from "../lib/runtime"
import { generateProjectTypes } from "../lib/typegen"
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

  const entry = resolve(options.entry ?? "sixb.config.ts")
  const host = options.host ?? "0.0.0.0"

  const app = renderPersistent(
    <LoadingView title="Starting sixb" subtitle={entry} status="Loading runtime" />
  )

  let server: SixbServer | null = null
  let atlasServer: AtlasAppServer | null = null
  let customAppServer: CustomAppDevServer | null = null
  let sixb: LoadedSixb | null = null
  let runtime: Awaited<ReturnType<typeof startSixbRuntime>> | null = null

  try {
    await generateProjectTypes({ entry })
    sixb = await loadSixbFromEntry(entry)
    const projectRoot = dirname(resolve(entry))

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

    runtime = await startSixbRuntime(sixb, {
      cohostWorkers: true,
      agentApiBaseUrl: topology.apiPublicOrigin,
    })
    const authEnabled = sixb.auth.isEnabled()

    app.rerender(<LoadingView title="Starting sixb" subtitle={entry} status="Starting server" />)

    server = createSixbServer({
      sixb: sixb as unknown as never,
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
      authEnabled,
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
      authEnabled,
    })

    let appUrl: string | null = null
    if (hasCustomApp) {
      app.rerender(
        <LoadingView title="Starting sixb" subtitle={entry} status="Starting custom app" />
      )

      customAppServer = await customApp.dev({
        host: topology.host,
        port: topology.appPort,
      })
      appUrl = topology.appPublicOrigin
    }

    app.rerender(
      <DevView
        name={sixb.id}
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
