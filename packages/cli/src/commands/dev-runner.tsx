import { dirname, resolve } from "node:path"
import { type CustomAppDevServer, createCustomApp } from "@sixb/app"
import { type AtlasAppServer, createAtlasApp } from "@sixb/atlas"
import { createSixbServer, type SixbServer } from "@sixb/server"
import { resolveAgentTurnTimeoutMs } from "../lib/agent-turn-timeout"
import { apiDocsUrl, apiEventsUrl, apiUrl, resolveBrowserTopology } from "../lib/browser-topology"
import { type LoadedSixbHost, loadSixbFromEntry } from "../lib/loadSixb"
import { startSixbRuntime, stopQuietly, stopSixbProviders } from "../lib/runtime"
import { generateProjectTypes } from "../lib/typegen"
import { resolveWorkerConcurrency } from "../lib/worker-concurrency"
import { DevView, LoadingView, renderCliError, renderPersistent } from "../ui"

export interface DevOptions {
  entry?: string
  port?: string
  host?: string
  apiPort?: string
  apiHost?: string
  apiPublicOrigin?: string
  atlasPublicOrigin?: string
  appPublicOrigin?: string
  agentTurnTimeout?: string
  concurrency?: readonly string[]
}

export async function runDevRuntime(options: DevOptions = {}) {
  process.env.NODE_ENV = "development"

  const agentTurnTimeoutMs = resolveAgentTurnTimeoutMs(options.agentTurnTimeout)
  const workerConcurrency = resolveWorkerConcurrency(options.concurrency)
  const entry = resolve(options.entry ?? "sixb.config.ts")

  const app = renderPersistent(
    <LoadingView title="Starting sixb" subtitle={entry} status="Loading runtime" />
  )

  let server: SixbServer | null = null
  let atlasServer: AtlasAppServer | null = null
  let customAppServer: CustomAppDevServer | null = null
  let sixb: LoadedSixbHost | null = null
  let runtime: Awaited<ReturnType<typeof startSixbRuntime>> | null = null
  let runtimeOwnsProviders = false
  const abort = new AbortController()
  const stopped = new Promise<void>((resolve) => {
    abort.signal.addEventListener("abort", () => resolve(), { once: true })
  })
  const requestShutdown = () => abort.abort()
  process.on("SIGINT", requestShutdown)
  process.on("SIGTERM", requestShutdown)

  try {
    await generateProjectTypes({ entry })
    abort.signal.throwIfAborted()
    const host: LoadedSixbHost = await loadSixbFromEntry(entry)
    sixb = host
    abort.signal.throwIfAborted()
    const projectRoot = dirname(resolve(entry))

    const customAppProbe = await createCustomApp({ rootDir: projectRoot })
    const hasCustomApp = await customAppProbe.hasRoutes()
    const topology = resolveBrowserTopology({
      role: "dev",
      host: options.host,
      apiHost: options.apiHost,
      port: options.port,
      apiPort: options.apiPort,
      apiPublicOrigin: options.apiPublicOrigin,
      atlasPublicOrigin: options.atlasPublicOrigin,
      appPublicOrigin: options.appPublicOrigin,
      hasCustomApp,
    })
    const customApp = await createCustomApp({
      rootDir: projectRoot,
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "app",
      authEnabled: host.auth.isEnabled(),
    })
    const authExperience = hasCustomApp
      ? ((await customApp.prepareAuthExperience()) ?? {
          outdir: resolve(projectRoot, ".sixb", "generated", "auth"),
        })
      : null

    abort.signal.throwIfAborted()
    runtimeOwnsProviders = true
    runtime = await startSixbRuntime(host, {
      cohostWorkers: true,
      agentApiBaseUrl: topology.apiPublicOrigin,
      agentTurnTimeoutMs,
      workerConcurrency,
    })
    abort.signal.throwIfAborted()
    const authEnabled = host.auth.isEnabled()

    app.rerender(<LoadingView title="Starting sixb" subtitle={entry} status="Starting server" />)

    server = createSixbServer({
      host: sixb,
      port: topology.apiPort,
      hostname: topology.apiHost,
      quiet: true,
      browser: {
        publicOrigin: topology.apiPublicOrigin,
        allowedOrigins: topology.allowedBrowserOrigins,
      },
      ...(authExperience ? { authExperience } : {}),
    })
    await server.start()
    abort.signal.throwIfAborted()

    const atlas = createAtlasApp({
      apiBaseUrl: topology.apiPublicOrigin,
      audience: "atlas",
      authEnabled,
    })
    atlasServer = await atlas.start({
      host: topology.host,
      port: topology.atlasPort,
      development: true,
    })
    abort.signal.throwIfAborted()

    let appUrl: string | null = null
    if (hasCustomApp) {
      app.rerender(
        <LoadingView title="Starting sixb" subtitle={entry} status="Starting custom app" />
      )

      customAppServer = await customApp.dev({
        host: topology.host,
        port: topology.appPort,
      })
      appUrl = topology.appPublicOrigin
    }
    abort.signal.throwIfAborted()

    app.rerender(
      <DevView
        name={sixb.id}
        apiUrl={apiUrl(topology)}
        apiDocsUrl={apiDocsUrl(topology)}
        wsUrl={apiEventsUrl(topology)}
        uiUrl={topology.atlasPublicOrigin}
        appUrl={appUrl}
        workers={[
          { type: "action", worker: runtime.actionWorker },
          { type: "agent", worker: runtime.agentWorker },
          { type: "projection", worker: runtime.projectionWorker },
          { type: "pipeline", worker: runtime.pipelineWorker },
          { type: "workflow", worker: runtime.workflowWorker },
          { type: "sync", worker: runtime.syncWorker },
        ].flatMap(({ type, worker }) =>
          worker ? [{ type, concurrency: worker.concurrency }] : []
        )}
        warnings={runtime.warnings}
      />
    )

    process.env.SIXB_DEV_READY = "1"
    process.send?.({ type: "ready", hasCustomApp })

    await Promise.race([stopped, runtime.waitForWorkerFailure()])
  } catch (error) {
    if (!abort.signal.aborted) {
      process.send?.({ type: "startup-error" })
      app.unmount()
      await renderCliError(error)
      process.exitCode = 1
    }
  } finally {
    process.env.SIXB_DEV_READY = ""
    app.unmount()
    await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
    await stopQuietly(() => atlasServer?.stop() ?? Promise.resolve())
    await stopQuietly(() => server?.stop() ?? Promise.resolve())
    await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
    if (sixb && !runtimeOwnsProviders) await stopSixbProviders(sixb)
    process.off("SIGINT", requestShutdown)
    process.off("SIGTERM", requestShutdown)
  }
}
