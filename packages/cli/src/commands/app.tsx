import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { type CustomAppDevServer, createCustomApp } from "@sixb/app"
import { resolveBrowserTopology } from "../lib/browser-topology"
import type { LoadedSixb } from "../lib/loadSixb"
import { builtAppOutdir, loadProductionSixb } from "../lib/production"
import { runUntilSignal, stopQuietly, stopSixbProviders } from "../lib/runtime"
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

  const loaded = await loadProductionSixb({ entry: options.entry, role: "app" })
  const app = renderPersistent(
    <LoadingView title="Starting sixb app" subtitle={loaded.entry} status="Starting app" />
  )

  let sixb: LoadedSixb | null = loaded.sixb
  let customAppServer: CustomAppDevServer | null = null

  try {
    const appOutdir = builtAppOutdir(loaded.buildOutdir)
    const hasBuiltCustomApp = await stat(resolve(appOutdir, "index.html"))
      .then(() => true)
      .catch(() => false)

    if (!hasBuiltCustomApp) {
      throw new Error(
        `[SixbCustomApp] No built app found in ${appOutdir}. Run \`sixb build\` before \`sixb app\`.`
      )
    }

    const topology = resolveBrowserTopology({
      mode: "production",
      host: options.host,
      appPort: options.port,
      apiPublicOrigin: options.apiPublicOrigin,
      appPublicOrigin: options.appPublicOrigin,
      includeAtlas: false,
      includeCustomApp: true,
    })
    if (!topology.appPublicOrigin) {
      throw new Error("[SixbCLI] Custom app public origin was not resolved.")
    }

    const customApp = await createCustomApp({
      rootDir: loaded.projectRoot,
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "app",
      authEnabled: sixb.auth.isEnabled(),
    })
    customAppServer = await customApp.start({
      host: topology.host,
      port: topology.appPort,
      outdir: appOutdir,
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "app",
      authEnabled: sixb.auth.isEnabled(),
    })

    app.rerender(
      <RoleView
        title="Sixb app started"
        name={sixb.id}
        serviceName="Custom app"
        items={[{ label: "URL", value: topology.appPublicOrigin }]}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down app...")
      await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
      if (sixb) {
        await stopSixbProviders(sixb)
      }
      sixb = null
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
    if (sixb) {
      await stopSixbProviders(sixb)
    }
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
