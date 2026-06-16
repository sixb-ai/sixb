import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { createSixbServer, type SixbServer } from "@sixb/server"
import { apiDocsUrl, apiEventsUrl, apiUrl, resolveBrowserTopology } from "../lib/browser-topology"
import type { LoadedSixb } from "../lib/loadSixb"
import { builtAppOutdir, loadProductionSixb } from "../lib/production"
import { runUntilSignal, stopQuietly, stopSixbProviders } from "../lib/runtime"
import { ErrorView, LoadingView, RoleView, renderPersistent, renderStatic } from "../ui"

export interface ApiOptions {
  entry?: string
  port?: string
  host?: string
  apiPort?: string
  apiHost?: string
  apiPublicOrigin?: string
  atlasPublicOrigin?: string
  appPublicOrigin?: string
}

export async function runApi(options: ApiOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionSixb({ entry: options.entry })
  const host = options.host ?? "0.0.0.0"
  const app = renderPersistent(
    <LoadingView title="Starting sixb api" subtitle={loaded.entry} status="Preparing runtime" />
  )

  let sixb: LoadedSixb | null = loaded.sixb
  let server: SixbServer | null = null

  try {
    const appOutdir = builtAppOutdir(loaded.buildOutdir)
    const hasBuiltCustomApp = await stat(resolve(appOutdir, "index.html"))
      .then(() => true)
      .catch(() => false)
    const topology = resolveBrowserTopology({
      mode: "production",
      host,
      apiHost: options.apiHost,
      port: options.port,
      apiPort: options.apiPort ?? options.port,
      apiPublicOrigin: options.apiPublicOrigin,
      atlasPublicOrigin: options.atlasPublicOrigin,
      appPublicOrigin: options.appPublicOrigin,
      includeCustomApp: hasBuiltCustomApp,
    })

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

    app.rerender(
      <RoleView
        title="Sixb API started"
        name={sixb.id}
        serviceName="API"
        items={[
          { label: "API", value: apiUrl(topology) },
          { label: "API docs", value: apiDocsUrl(topology) },
          { label: "Events", value: apiEventsUrl(topology) },
        ]}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down api...")
      await stopQuietly(() => server?.stop() ?? Promise.resolve())
      if (sixb) {
        await stopSixbProviders(sixb)
      }
      sixb = null
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => server?.stop() ?? Promise.resolve())
    if (sixb) {
      await stopSixbProviders(sixb)
    }
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
