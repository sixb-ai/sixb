import type { CustomAppDevServer } from "@sixb/app"
import {
  answerBrowserRoleProbe,
  isBrowserRoleProbe,
  probeBrowserRoleProject,
} from "../lib/browser-role-probe"
import { resolveBrowserTopology, servedUrl } from "../lib/browser-topology"
import {
  builtAppOutdir,
  hasBuiltCustomApp,
  resolveProductionPaths,
  resolveRuntimeEntry,
} from "../lib/production"
import { runUntilSignal, stopQuietly } from "../lib/role-lifecycle"
import { LoadingView, RoleView, renderCliError, renderPersistent } from "../ui"

export interface AppOptions {
  entry?: string
  port?: string
  host?: string
  apiPublicOrigin?: string
  appPublicOrigin?: string
}

export async function runApp(options: AppOptions = {}) {
  process.env.NODE_ENV = "production"

  if (isBrowserRoleProbe()) {
    try {
      await answerBrowserRoleProbe({ entry: options.entry, role: "app" })
    } catch (error) {
      await renderCliError(error)
      process.exit(1)
    }
    process.exit(0)
  }

  const entry = await resolveRuntimeEntry({ entry: options.entry })
  // The server package loads while the probe reads the project, and the probe never loads it.
  const [project, { createCustomApp }] = await Promise.all([
    probeBrowserRoleProject("app"),
    import("@sixb/app"),
  ])
  const { projectRoot, buildOutdir } = await resolveProductionPaths(entry)
  const app = renderPersistent(
    <LoadingView title="Starting sixb app" subtitle={entry} status="Starting app" />
  )

  let customAppServer: CustomAppDevServer | null = null

  try {
    const appOutdir = builtAppOutdir(buildOutdir)
    if (!(await hasBuiltCustomApp(appOutdir))) {
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
      audience: "app",
      authEnabled: project.authEnabled,
    })
    customAppServer = await customApp.start({
      host: topology.host,
      port: topology.appPort,
      outdir: appOutdir,
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "app",
      authEnabled: project.authEnabled,
    })

    app.rerender(
      <RoleView
        title="Sixb app started"
        name={project.id}
        serviceName="Custom app"
        items={[{ label: "URL", value: servedUrl(topology) }]}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down app...")
      await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
    await renderCliError(error)
    process.exit(1)
  }
}
