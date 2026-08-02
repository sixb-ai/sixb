import { type AtlasAppServer, createAtlasApp } from "@sixb/atlas"
import { resolveBrowserTopology, servedUrl } from "../lib/browser-topology"
import type { LoadedSixb } from "../lib/loadSixb"
import { builtAtlasOutdir, loadProductionSixb } from "../lib/production"
import { runUntilSignal, stopQuietly, stopSixbProviders } from "../lib/runtime"
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

  const loaded = await loadProductionSixb({ entry: options.entry, role: "atlas" })
  const app = renderPersistent(
    <LoadingView title="Starting sixb atlas" subtitle={loaded.entry} status="Starting Atlas" />
  )

  let sixb: LoadedSixb | null = loaded.sixb
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
      authEnabled: sixb.auth.isEnabled(),
    })
    atlasServer = await atlas.start({
      host: topology.host,
      port: topology.atlasPort,
      development: false,
      outdir: builtAtlasOutdir(loaded.buildOutdir),
    })

    app.rerender(
      <RoleView
        title="Sixb Atlas started"
        name={sixb.id}
        serviceName="Atlas"
        items={[{ label: "URL", value: servedUrl(topology) }]}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down atlas...")
      await stopQuietly(() => atlasServer?.stop() ?? Promise.resolve())
      if (sixb) {
        await stopSixbProviders(sixb)
      }
      sixb = null
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => atlasServer?.stop() ?? Promise.resolve())
    if (sixb) {
      await stopSixbProviders(sixb)
    }
    await renderCliError(error)
    process.exit(1)
  }
}
