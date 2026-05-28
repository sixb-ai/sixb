import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { createParioServer, type ParioServer } from "@pario/server"
import { apiDocsUrl, apiEventsUrl, apiUrl, resolveBrowserTopology } from "../lib/browser-topology"
import type { LoadedPario } from "../lib/loadPario"
import { builtAppOutdir, loadProductionPario } from "../lib/production"
import {
  prepareParioRuntime,
  runUntilSignal,
  stopParioProviders,
  stopQuietly,
} from "../lib/runtime"
import { ErrorView, LoadingView, RoleView, renderPersistent, renderStatic } from "../ui"

export interface ApiOptions {
  entry?: string
  port?: string
  host?: string
  apiPort?: string
  apiHost?: string
  apiPublicOrigin?: string
  atlasPublicOrigin?: string
  sentinelPublicOrigin?: string
  appPublicOrigin?: string
}

export async function runApi(options: ApiOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionPario({ entry: options.entry })
  const host = options.host ?? "0.0.0.0"
  const app = renderPersistent(
    <LoadingView title="Starting pario api" subtitle={loaded.entry} status="Preparing runtime" />
  )

  let pario: LoadedPario | null = loaded.pario
  let server: ParioServer | null = null

  try {
    await prepareParioRuntime(pario)

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
      sentinelPublicOrigin: options.sentinelPublicOrigin,
      appPublicOrigin: options.appPublicOrigin,
      includeCustomApp: hasBuiltCustomApp,
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

    app.rerender(
      <RoleView
        title="Pario API started"
        name={pario.id}
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
      if (pario) {
        await stopParioProviders(pario)
      }
      pario = null
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => server?.stop() ?? Promise.resolve())
    if (pario) {
      await stopParioProviders(pario)
    }
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
