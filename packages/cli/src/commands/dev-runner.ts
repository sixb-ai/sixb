import { dirname, resolve } from "node:path"
import {
  AppPackagesMissingError,
  type CustomAppDevOptions,
  type CustomAppDevServer,
  createCustomApp,
} from "@sixb/app/server"
import { createSixbServer } from "@sixb/server"
import {
  apiDocsUrl,
  apiEventsUrl,
  apiUrl,
  resolveBrowserTopology,
  servedUrl,
} from "../lib/browser-topology"
import {
  DEV_UI_ENV,
  type DevChildMessage,
  type DevReadyView,
  type DevStartupStep,
} from "../lib/dev-messages"
import { errorMessage, errorRemediation } from "../lib/errors"
import { type LoadedSixbHost, loadSixbFromEntry } from "../lib/loadSixb"
import { stopQuietly } from "../lib/role-lifecycle"
import { startSixbRuntime, stopSixbProviders } from "../lib/runtime"
import { generateProjectTypes } from "../lib/typegen"
import {
  resolveSubagentConcurrency,
  resolveVectorConcurrency,
  resolveWorkerConcurrency,
} from "../lib/worker-concurrency"
import { devView, renderCliError, renderStatic, startTask } from "../ui"

export interface DevOptions {
  entry?: string
  port?: string
  host?: string
  apiPort?: string
  apiHost?: string
  apiPublicOrigin?: string
  appPublicOrigin?: string
  concurrency?: readonly string[]
  vectorConcurrency?: string
  subagentConcurrency?: string
  subagentConcurrencyPerRun?: string
  /** Also open the app in a desktop window. The supervisor does, so the window outlives restarts. */
  desktop?: boolean
}

export async function runDevRuntime(options: DevOptions = {}) {
  process.env.NODE_ENV = "development"

  const workerConcurrency = resolveWorkerConcurrency(options.concurrency)
  const vectorConcurrency = resolveVectorConcurrency(options.vectorConcurrency)
  const subagents = resolveSubagentConcurrency({
    perWorker: options.subagentConcurrency,
    perRun: options.subagentConcurrencyPerRun,
  })
  const entry = resolve(options.entry ?? "sixb.config.ts")

  // Under a supervisor that draws the live footer, this process reports and prints nothing.
  const reportOnly = process.env[DEV_UI_ENV] === "footer"
  const send = (message: DevChildMessage) => process.send?.(message)
  const task = reportOnly ? null : startTask("dev", "Generating types")
  const step = (name: DevStartupStep) => {
    if (reportOnly) send({ type: "status", step: name })
    else task?.step(name)
  }

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
    step("Generating types")
    await generateProjectTypes({ entry })
    abort.signal.throwIfAborted()
    step("Loading project")
    const host: LoadedSixbHost = await loadSixbFromEntry(entry)
    sixb = host
    abort.signal.throwIfAborted()
    const projectRoot = dirname(resolve(entry))

    const topology = resolveBrowserTopology({
      role: "dev",
      host: options.host,
      apiHost: options.apiHost,
      port: options.port,
      apiPort: options.apiPort,
      apiPublicOrigin: options.apiPublicOrigin,
      appPublicOrigin: options.appPublicOrigin,
    })
    const customApp = await createCustomApp({
      rootDir: projectRoot,
      apiBaseUrl: topology.apiPublicOrigin,
      authEnabled: host.auth.isEnabled(),
    })
    const authExperience = (await customApp.prepareAuthExperience()) ?? {
      outdir: resolve(projectRoot, ".sixb", "generated", "auth"),
    }

    abort.signal.throwIfAborted()
    const server = createSixbServer({
      host: sixb,
      port: topology.apiPort,
      hostname: topology.apiHost,
      quiet: true,
      browser: {
        publicOrigin: topology.apiPublicOrigin,
        allowedOrigins: topology.allowedBrowserOrigins,
      },
      authExperience,
    })
    runtimeOwnsProviders = true
    // The runtime owns the server's lifecycle so agent turns run only while it listens.
    runtime = await startSixbRuntime(host, {
      cohostWorkers: true,
      api: {
        start: () => {
          step("Starting server")
          return server.start()
        },
        stop: () => server.stop(),
      },
      agentApiBaseUrl: topology.apiPublicOrigin,
      workerConcurrency,
      vectorConcurrency,
      ...subagents,
    })
    abort.signal.throwIfAborted()

    step("Starting app")
    const devApp = await startDevApp(customApp, { host: topology.host, port: topology.appPort })
    customAppServer = devApp.server
    abort.signal.throwIfAborted()

    const view: DevReadyView = {
      name: sixb.id,
      apiUrl: apiUrl(topology),
      apiDocsUrl: apiDocsUrl(topology),
      wsUrl: apiEventsUrl(topology),
      appUrl: customAppServer ? servedUrl(topology) : null,
      workers: [
        { type: "agent", worker: runtime.agentWorker },
        { type: "projection", worker: runtime.projectionWorker },
        { type: "pipeline", worker: runtime.pipelineWorker },
        { type: "workflow", worker: runtime.workflowWorker },
        { type: "sync", worker: runtime.syncWorker },
      ].flatMap(({ type, worker }) => (worker ? [{ type, concurrency: worker.concurrency }] : [])),
      warnings: devApp.warning ? [devApp.warning, ...runtime.warnings] : runtime.warnings,
    }
    task?.stop()
    if (!reportOnly) await renderStatic(devView(view))

    process.env.SIXB_DEV_READY = "1"
    send({
      type: "ready",
      watchesApp: customAppServer?.watchesSources ?? false,
      app: customAppServer
        ? { url: servedUrl(topology), apiOrigin: topology.apiPublicOrigin }
        : null,
      view,
    })

    await Promise.race([stopped, runtime.waitForWorkerFailure()])
  } catch (error) {
    if (!abort.signal.aborted) {
      const remediation = errorRemediation(error)
      send({
        type: "startup-error",
        error: { message: errorMessage(error), ...(remediation ? { remediation } : {}) },
      })
      task?.stop()
      if (!reportOnly) await renderCliError(error)
      process.exitCode = 1
    }
  } finally {
    process.env.SIXB_DEV_READY = ""
    task?.stop()
    await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
    await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
    if (sixb && !runtimeOwnsProviders) await stopSixbProviders(sixb)
    process.off("SIGINT", requestShutdown)
    process.off("SIGTERM", requestShutdown)
  }
}

/**
 * Starts the app's dev server. A project missing the packages the app is bundled from still gets
 * its API, with the install command as a warning; `sixb build` refuses instead.
 */
export async function startDevApp(
  customApp: { dev(options: CustomAppDevOptions): Promise<CustomAppDevServer> },
  options: CustomAppDevOptions
): Promise<{ readonly server: CustomAppDevServer | null; readonly warning?: string }> {
  try {
    return { server: await customApp.dev(options) }
  } catch (error) {
    if (!(error instanceof AppPackagesMissingError)) throw error
    return { server: null, warning: error.message.replace("[SixbCustomApp] ", "") }
  }
}
