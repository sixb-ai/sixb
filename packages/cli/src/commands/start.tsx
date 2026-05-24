import { stat } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { type CustomAppDevServer, createCustomApp } from "@pario/app"
import { type AtlasAppServer, createAtlasApp } from "@pario/atlas"
import { createParioServer, type ParioServer } from "@pario/server"
import { apiDocsUrl, apiEventsUrl, apiUrl, resolveBrowserTopology } from "../lib/browser-topology"
import { type LoadedPario, loadParioFromEntry } from "../lib/loadPario"
import { runUntilSignal, startParioRuntime, stopQuietly } from "../lib/runtime"
import { ErrorView, LoadingView, renderPersistent, renderStatic, StartView } from "../ui"

export interface StartOptions {
  entry?: string
  port?: string
  host?: string
  apiPort?: string
  apiHost?: string
  apiPublicOrigin?: string
  atlasPublicOrigin?: string
  appPublicOrigin?: string
}

export async function runStart(options: StartOptions = {}) {
  process.env.NODE_ENV = "production"

  const sourceEntry = resolve("pario.config.ts")
  const defaultBuiltEntry = resolve(".pario/dist/pario.config.js")
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
  let atlasServer: AtlasAppServer | null = null
  let customAppServer: CustomAppDevServer | null = null
  let pario: LoadedPario | null = null
  let runtime: Awaited<ReturnType<typeof startParioRuntime>> | null = null
  const warnings: string[] = []

  try {
    pario = await loadParioFromEntry(entry)
    runtime = await startParioRuntime(pario, { cohostWorkers: false })
    const authEnabled = pario.auth.isEnabled()
    const projectRoot = resolveProjectRoot(entry)

    const builtAppEntry = resolve(projectRoot, ".pario", "dist", "app", "index.html")
    const hasBuiltCustomApp = await stat(builtAppEntry)
      .then(() => true)
      .catch(() => false)
    const topology = resolveBrowserTopology({
      mode: "production",
      host,
      apiHost: options.apiHost,
      port: options.port,
      apiPort: options.apiPort,
      apiPublicOrigin: options.apiPublicOrigin,
      atlasPublicOrigin: options.atlasPublicOrigin,
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

    const atlas = createAtlasApp({
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "atlas",
      authEnabled,
    })
    atlasServer = await atlas.start({
      host: topology.host,
      port: topology.atlasPort,
      development: false,
    })

    const customApp = await createCustomApp({
      rootDir: projectRoot,
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "app",
      authEnabled,
    })

    let appUrl: string | null = null
    if (hasBuiltCustomApp) {
      customAppServer = await customApp.start({
        host: topology.host,
        port: topology.appPort,
        outdir: resolve(projectRoot, ".pario", "dist", "app"),
        apiBaseUrl: topology.apiPublicOrigin,
        audience: "app",
        authEnabled,
      })
      appUrl = topology.appPublicOrigin
    } else if (await customApp.hasRoutes()) {
      warnings.push(
        "Custom app source found, but no production build exists at .pario/dist/app. Run `pario build` first."
      )
    }

    app.rerender(
      <StartView
        name={pario.id}
        apiUrl={apiUrl(topology)}
        apiDocsUrl={apiDocsUrl(topology)}
        wsUrl={apiEventsUrl(topology)}
        uiUrl={topology.atlasPublicOrigin}
        uiStatus={null}
        appUrl={appUrl}
        warnings={warnings}
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

function resolveProjectRoot(entry: string): string {
  const resolvedEntry = resolve(entry)
  const distMarker = `${sep}.pario${sep}dist${sep}`
  const distIndex = resolvedEntry.lastIndexOf(distMarker)

  if (distIndex >= 0) {
    return resolvedEntry.slice(0, distIndex)
  }

  return dirname(resolvedEntry)
}
