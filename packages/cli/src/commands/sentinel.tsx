import { createSentinelApp, type SentinelAppServer } from "@sixb/sentinel"
import { resolveBrowserTopology } from "../lib/browser-topology"
import type { LoadedSixb } from "../lib/loadSixb"
import { builtSentinelOutdir, loadProductionSixb } from "../lib/production"
import { runUntilSignal, stopQuietly, stopSixbProviders } from "../lib/runtime"
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

  const loaded = await loadProductionSixb({ entry: options.entry })
  const host = options.host ?? "0.0.0.0"
  const app = renderPersistent(
    <LoadingView
      title="Starting sixb sentinel"
      subtitle={loaded.entry}
      status="Starting Sentinel"
    />
  )

  let sixb: LoadedSixb | null = loaded.sixb
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
      throw new Error("[SixbCLI] Sentinel public origin was not resolved.")
    }

    const sentinel = createSentinelApp({
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "sentinel",
      authEnabled: sixb.auth.isEnabled(),
    })
    sentinelServer = await sentinel.start({
      host: topology.host,
      port: topology.sentinelPort,
      development: false,
      outdir: builtSentinelOutdir(loaded.buildOutdir),
    })

    app.rerender(
      <RoleView
        title="Sixb Sentinel started"
        name={sixb.id}
        serviceName="Sentinel"
        items={[{ label: "URL", value: topology.sentinelPublicOrigin }]}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down sentinel...")
      await stopQuietly(() => sentinelServer?.stop() ?? Promise.resolve())
      if (sixb) {
        await stopSixbProviders(sixb)
      }
      sixb = null
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => sentinelServer?.stop() ?? Promise.resolve())
    if (sixb) {
      await stopSixbProviders(sixb)
    }
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
