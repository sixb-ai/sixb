import { type AtlasAppServer, createAtlasApp } from "@pario/atlas"
import { resolveBrowserTopology } from "../lib/browser-topology"
import type { LoadedPario } from "../lib/loadPario"
import { builtAtlasOutdir, loadProductionPario } from "../lib/production"
import { runUntilSignal, stopParioProviders, stopQuietly } from "../lib/runtime"
import { ErrorView, LoadingView, RoleView, renderPersistent, renderStatic } from "../ui"

export interface AtlasOptions {
  entry?: string
  port?: string
  host?: string
  apiPublicOrigin?: string
  atlasPublicOrigin?: string
}

export async function runAtlas(options: AtlasOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionPario({ entry: options.entry })
  const host = options.host ?? "0.0.0.0"
  const app = renderPersistent(
    <LoadingView title="Starting pario atlas" subtitle={loaded.entry} status="Starting Atlas" />
  )

  let pario: LoadedPario | null = loaded.pario
  let atlasServer: AtlasAppServer | null = null

  try {
    const topology = resolveBrowserTopology({
      mode: "production",
      host,
      port: options.port,
      apiPublicOrigin: options.apiPublicOrigin,
      atlasPublicOrigin: options.atlasPublicOrigin,
      includeAtlas: true,
      includeSentinel: false,
      includeCustomApp: false,
    })
    if (!topology.atlasPublicOrigin) {
      throw new Error("[ParioCLI] Atlas public origin was not resolved.")
    }

    const atlas = createAtlasApp({
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "atlas",
      authEnabled: pario.auth.isEnabled(),
    })
    atlasServer = await atlas.start({
      host: topology.host,
      port: topology.atlasPort,
      development: false,
      outdir: builtAtlasOutdir(loaded.buildOutdir),
    })

    app.rerender(
      <RoleView
        title="Pario Atlas started"
        name={pario.id}
        serviceName="Atlas"
        items={[{ label: "URL", value: topology.atlasPublicOrigin }]}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down atlas...")
      await stopQuietly(() => atlasServer?.stop() ?? Promise.resolve())
      if (pario) {
        await stopParioProviders(pario)
      }
      pario = null
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => atlasServer?.stop() ?? Promise.resolve())
    if (pario) {
      await stopParioProviders(pario)
    }
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
