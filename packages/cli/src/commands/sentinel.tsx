import { createSentinelApp, type SentinelAppServer } from "@pario/sentinel"
import { resolveBrowserTopology } from "../lib/browser-topology"
import type { LoadedPario } from "../lib/loadPario"
import { builtSentinelOutdir, loadProductionPario } from "../lib/production"
import { runUntilSignal, stopParioProviders, stopQuietly } from "../lib/runtime"
import { ErrorView, LoadingView, RoleView, renderPersistent, renderStatic } from "../ui"

export interface SentinelOptions {
  entry?: string
  port?: string
  host?: string
  apiPublicOrigin?: string
  sentinelPublicOrigin?: string
}

export async function runSentinel(options: SentinelOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionPario({ entry: options.entry })
  const host = options.host ?? "0.0.0.0"
  const app = renderPersistent(
    <LoadingView
      title="Starting pario sentinel"
      subtitle={loaded.entry}
      status="Starting Sentinel"
    />
  )

  let pario: LoadedPario | null = loaded.pario
  let sentinelServer: SentinelAppServer | null = null

  try {
    const topology = resolveBrowserTopology({
      mode: "production",
      host,
      sentinelPort: options.port,
      apiPublicOrigin: options.apiPublicOrigin,
      sentinelPublicOrigin: options.sentinelPublicOrigin,
      includeAtlas: false,
      includeSentinel: true,
      includeCustomApp: false,
    })
    if (!topology.sentinelPublicOrigin) {
      throw new Error("[ParioCLI] Sentinel public origin was not resolved.")
    }

    const sentinel = createSentinelApp({
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "sentinel",
      authEnabled: pario.auth.isEnabled(),
    })
    sentinelServer = await sentinel.start({
      host: topology.host,
      port: topology.sentinelPort,
      development: false,
      outdir: builtSentinelOutdir(loaded.buildOutdir),
    })

    app.rerender(
      <RoleView
        title="Pario Sentinel started"
        name={pario.id}
        serviceName="Sentinel"
        items={[{ label: "URL", value: topology.sentinelPublicOrigin }]}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down sentinel...")
      await stopQuietly(() => sentinelServer?.stop() ?? Promise.resolve())
      if (pario) {
        await stopParioProviders(pario)
      }
      pario = null
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => sentinelServer?.stop() ?? Promise.resolve())
    if (pario) {
      await stopParioProviders(pario)
    }
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
