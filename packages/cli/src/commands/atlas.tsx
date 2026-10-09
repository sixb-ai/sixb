import { basename } from "node:path"
import { type AtlasAppServer, createAtlasApp } from "@sixb/atlas"
import { resolveBrowserTopology, servedUrl } from "../lib/browser-topology"
import { builtAtlasOutdir, resolveProductionPaths, resolveRuntimeEntry } from "../lib/production"
import { runUntilSignal, stopQuietly } from "../lib/role-lifecycle"
import { loadRoleView } from "../lib/role-view"

export interface AtlasOptions {
  entry?: string
  port?: string
  host?: string
  apiPublicOrigin?: string
  atlasPublicOrigin?: string
}

export async function runAtlas(options: AtlasOptions = {}) {
  // Before NODE_ENV changes: see loadRoleView.
  const view = await loadRoleView()
  process.env.NODE_ENV = "production"

  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const { projectRoot, buildOutdir } = await resolveProductionPaths(entry)
  const app = view.startup({
    title: "Starting sixb atlas",
    subtitle: entry,
    status: "Starting Atlas",
  })

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
      // No authEnabled: the page asks the API whether the project uses auth, so serving the
      // bundle never loads the project.
    })
    atlasServer = await atlas.start({
      host: topology.host,
      port: topology.atlasPort,
      development: false,
      outdir: builtAtlasOutdir(buildOutdir),
    })

    app.started({
      title: "Sixb Atlas started",
      name: basename(projectRoot),
      serviceName: "Atlas",
      items: [{ label: "URL", value: servedUrl(topology) }],
    })

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down atlas...")
      await stopQuietly(() => atlasServer?.stop() ?? Promise.resolve())
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => atlasServer?.stop() ?? Promise.resolve())
    await view.error(error)
    process.exit(1)
  }
}
