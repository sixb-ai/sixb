import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { type CustomAppDevServer, createCustomApp } from "@pario/app"
import { resolveBrowserTopology } from "../lib/browser-topology"
import type { LoadedPario } from "../lib/loadPario"
import { builtAppOutdir, loadProductionPario } from "../lib/production"
import { runUntilSignal, stopParioProviders, stopQuietly } from "../lib/runtime"
import { ErrorView, LoadingView, RoleView, renderPersistent, renderStatic } from "../ui"

export interface AppOptions {
  entry?: string
  port?: string
  host?: string
  apiPublicOrigin?: string
  appPublicOrigin?: string
}

export async function runApp(options: AppOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionPario({ entry: options.entry })
  const host = options.host ?? "0.0.0.0"
  const app = renderPersistent(
    <LoadingView title="Starting pario app" subtitle={loaded.entry} status="Starting app" />
  )

  let pario: LoadedPario | null = loaded.pario
  let customAppServer: CustomAppDevServer | null = null

  try {
    const appOutdir = builtAppOutdir(loaded.buildOutdir)
    const hasBuiltCustomApp = await stat(resolve(appOutdir, "index.html"))
      .then(() => true)
      .catch(() => false)

    if (!hasBuiltCustomApp) {
      throw new Error(
        `[ParioCustomApp] No built app found in ${appOutdir}. Run \`pario build\` before \`pario app\`.`
      )
    }

    const topology = resolveBrowserTopology({
      mode: "production",
      host,
      appPort: options.port,
      apiPublicOrigin: options.apiPublicOrigin,
      appPublicOrigin: options.appPublicOrigin,
      includeAtlas: false,
      includeSentinel: false,
      includeCustomApp: true,
    })
    if (!topology.appPublicOrigin) {
      throw new Error("[ParioCLI] Custom app public origin was not resolved.")
    }

    const customApp = await createCustomApp({
      rootDir: loaded.projectRoot,
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "app",
      authEnabled: pario.auth.isEnabled(),
    })
    customAppServer = await customApp.start({
      host: topology.host,
      port: topology.appPort,
      outdir: appOutdir,
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "app",
      authEnabled: pario.auth.isEnabled(),
    })

    app.rerender(
      <RoleView
        title="Pario app started"
        name={pario.id}
        serviceName="Custom app"
        items={[{ label: "URL", value: topology.appPublicOrigin }]}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down app...")
      await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
      if (pario) {
        await stopParioProviders(pario)
      }
      pario = null
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
    if (pario) {
      await stopParioProviders(pario)
    }
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
