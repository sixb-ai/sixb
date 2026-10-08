import type { AtlasAppServer } from "@sixb/atlas"
import {
  answerBrowserRoleProbe,
  isBrowserRoleProbe,
  probeBrowserRoleProject,
} from "../lib/browser-role-probe"
import { resolveBrowserTopology, servedUrl } from "../lib/browser-topology"
import { builtAtlasOutdir, resolveProductionPaths, resolveRuntimeEntry } from "../lib/production"
import { runUntilSignal, stopQuietly } from "../lib/role-lifecycle"
import { LoadingView, RoleView, renderCliError, renderPersistent } from "../ui"

export interface AtlasOptions {
  entry?: string
  port?: string
  host?: string
  apiPublicOrigin?: string
  atlasPublicOrigin?: string
}

export async function runAtlas(options: AtlasOptions = {}) {
  process.env.NODE_ENV = "production"

  if (isBrowserRoleProbe()) {
    try {
      await answerBrowserRoleProbe({ entry: options.entry, role: "atlas" })
    } catch (error) {
      await renderCliError(error)
      process.exit(1)
    }
    process.exit(0)
  }

  const entry = await resolveRuntimeEntry({ entry: options.entry })
  // The server package loads while the probe reads the project, and the probe never loads it.
  const [project, { createAtlasApp }] = await Promise.all([
    probeBrowserRoleProject("atlas"),
    import("@sixb/atlas"),
  ])
  const { buildOutdir } = await resolveProductionPaths(entry)
  const app = renderPersistent(
    <LoadingView title="Starting sixb atlas" subtitle={entry} status="Starting Atlas" />
  )

  let atlasServer: AtlasAppServer | null = null

  try {
    const topology = resolveBrowserTopology({
      role: "atlas",
      host: options.host,
      port: options.port,
      apiPublicOrigin: options.apiPublicOrigin,
      atlasPublicOrigin: options.atlasPublicOrigin,
    })

    const atlas = createAtlasApp({
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "atlas",
      authEnabled: project.authEnabled,
    })
    atlasServer = await atlas.start({
      host: topology.host,
      port: topology.atlasPort,
      development: false,
      outdir: builtAtlasOutdir(buildOutdir),
    })

    app.rerender(
      <RoleView
        title="Sixb Atlas started"
        name={project.id}
        serviceName="Atlas"
        items={[{ label: "URL", value: servedUrl(topology) }]}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down atlas...")
      await stopQuietly(() => atlasServer?.stop() ?? Promise.resolve())
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => atlasServer?.stop() ?? Promise.resolve())
    await renderCliError(error)
    process.exit(1)
  }
}
