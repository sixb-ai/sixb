import { basename } from "node:path"
import { type CustomAppServer, createCustomApp } from "@sixb/app/server"
import { resolveBrowserTopology, servedUrl } from "../lib/browser-topology"
import {
  builtAppOutdir,
  hasBuiltApp,
  resolveProductionPaths,
  resolveRuntimeEntry,
} from "../lib/production"
import { runUntilSignal, stopQuietly } from "../lib/role-lifecycle"
import { loadRoleView } from "../lib/role-view"

export interface AppOptions {
  entry?: string
  port?: string
  host?: string
  apiPublicOrigin?: string
  appPublicOrigin?: string
}

export async function runApp(options: AppOptions = {}) {
  // Before NODE_ENV changes: see loadRoleView.
  const view = await loadRoleView()
  process.env.NODE_ENV = "production"

  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const { projectRoot, buildOutdir } = await resolveProductionPaths(entry)
  const app = view.startup({
    title: "Starting sixb app",
    subtitle: entry,
    status: "Starting app",
  })

  let customAppServer: CustomAppServer | null = null

  try {
    const appOutdir = builtAppOutdir(buildOutdir)
    if (!(await hasBuiltApp(appOutdir))) {
      throw new Error(
        `[SixbCustomApp] No built app found in ${appOutdir}. Run \`sixb build\` before \`sixb app\`.`
      )
    }

    const topology = resolveBrowserTopology({
      role: "app",
      host: options.host,
      port: options.port,
      apiPublicOrigin: options.apiPublicOrigin,
      appPublicOrigin: options.appPublicOrigin,
    })

    const customApp = await createCustomApp({
      rootDir: projectRoot,
      apiBaseUrl: topology.apiPublicOrigin,
      // No authEnabled: the page asks the API whether the project uses auth, so serving the
      // bundle never loads the project.
    })
    customAppServer = await customApp.start({
      host: topology.host,
      port: topology.appPort,
      outdir: appOutdir,
      apiBaseUrl: topology.apiPublicOrigin,
    })

    app.started({
      title: "Sixb app started",
      name: basename(projectRoot),
      serviceName: "App",
      items: [{ label: "URL", value: servedUrl(topology) }],
    })

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down app...")
      await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
    await view.error(error)
    process.exit(1)
  }
}
