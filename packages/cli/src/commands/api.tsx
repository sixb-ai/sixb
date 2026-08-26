import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { createSixbServer, type SixbServer } from "@sixb/server"
import { apiDocsUrl, apiEventsUrl, apiUrl, resolveBrowserTopology } from "../lib/browser-topology"
import type { LoadedSixbHost } from "../lib/loadSixb"
import { builtAppOutdir, loadProductionSixb } from "../lib/production"
import { runUntilSignal, stopQuietly, stopSixbProviders } from "../lib/runtime"
import { migrateStorageForRole } from "../lib/storage-migration"
import { LoadingView, RoleView, renderCliError, renderPersistent } from "../ui"

export interface ApiOptions {
  entry?: string
  noMigrate?: boolean
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

  const loaded = await loadProductionSixb({ entry: options.entry, role: "api" })
  const app = renderPersistent(
    <LoadingView title="Starting sixb api" subtitle={loaded.entry} status="Preparing runtime" />
  )

  let sixb: LoadedSixbHost | null = loaded.sixb
  let server: SixbServer | null = null

  try {
    // Ahead of `server.start()`, which is what kicks off the read-only schema probe
    // behind `/ready`. Migrating after it would leave the probe racing the change it
    // reports on, and the first `/ready` answer would be stale by construction.
    const migration = await migrateStorageForRole(sixb, {
      role: "api",
      noMigrate: options.noMigrate,
      onStart: () =>
        app.rerender(
          <LoadingView
            title="Starting sixb api"
            subtitle={loaded.entry}
            status="Migrating storage"
          />
        ),
    })

    const appOutdir = builtAppOutdir(loaded.buildOutdir)
    const hasBuiltCustomApp = await stat(resolve(appOutdir, "index.html"))
      .then(() => true)
      .catch(() => false)
    const authExperienceOutdir = resolve(appOutdir, "auth")
    const hasAuthExperience = await stat(resolve(authExperienceOutdir, "index.html"))
      .then(() => true)
      .catch(() => false)
    const topology = resolveBrowserTopology({
      role: "api",
      host: options.host,
      apiHost: options.apiHost,
      port: options.port,
      apiPort: options.apiPort,
      apiPublicOrigin: options.apiPublicOrigin,
      atlasPublicOrigin: options.atlasPublicOrigin,
      appPublicOrigin: options.appPublicOrigin,
      hasCustomApp: hasBuiltCustomApp,
    })

    server = createSixbServer({
      host: sixb,
      port: topology.apiPort,
      hostname: topology.apiHost,
      quiet: true,
      browser: {
        publicOrigin: topology.apiPublicOrigin,
        allowedOrigins: topology.allowedBrowserOrigins,
      },
      ...(hasAuthExperience ? { authExperience: { outdir: authExperienceOutdir } } : {}),
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
        storage={migration.summary}
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
    await renderCliError(error)
    process.exit(1)
  }
}
