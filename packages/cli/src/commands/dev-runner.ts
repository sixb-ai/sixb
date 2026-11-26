import { dirname, resolve } from "node:path"
import {
  AppPackagesMissingError,
  type CustomAppDevOptions,
  type CustomAppDevServer,
  createCustomApp,
} from "@sixb/app/server"
import { createSixbServer, requestTimingOptionsFromEnv } from "@sixb/server"
import {
  type BranchFromProduction,
  branchFromProduction,
  currentGitBranch,
  localGitBranches,
} from "../lib/branch-from-production"
import {
  apiDocsUrl,
  apiEventsUrl,
  apiUrl,
  type BrowserTopology,
  exposedBeyondThisMachine,
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
  /** `"production"`: run this git branch on a copy of what you read in production. */
  from?: string
  /** With `from`: take a new copy, discarding what the branch wrote to the last one. */
  refresh?: boolean
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
  let branchBase: LoadedSixbHost | null = null
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
    const projectRoot = dirname(resolve(entry))
    const loaded: LoadedSixbHost = await loadSixbFromEntry(entry)
    sixb = loaded
    abort.signal.throwIfAborted()

    const topology = resolveBrowserTopology({
      role: "dev",
      host: options.host,
      apiHost: options.apiHost,
      port: options.port,
      apiPort: options.apiPort,
      apiPublicOrigin: options.apiPublicOrigin,
      appPublicOrigin: options.appPublicOrigin,
    })
    const branch =
      options.from === "production"
        ? await openBranch(loaded, projectRoot, topology, (done) => send({ type: "loading", done }))
        : null
    const host = branch?.host ?? loaded
    if (branch) {
      // The project's own providers serve nothing on the branch, but the runtime stops only its host's.
      branchBase = loaded
      sixb = host
    }
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
      // The orchestrator this process co-hosts owns it.
      ontologyMaintenance: false,
      // So does the lake worker.
      ingestFlush: false,
      browser: {
        publicOrigin: topology.apiPublicOrigin,
        allowedOrigins: topology.allowedBrowserOrigins,
      },
      authExperience,
      // Always on while developing, so a slow request can be read from the Network tab.
      timing: { ...requestTimingOptionsFromEnv(), header: true },
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
        stop: () => server.stop({ timeoutMs: 0 }),
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
        { type: "lake", worker: runtime.lakeWorker },
        { type: "render", worker: runtime.renderWorker },
      ].flatMap(({ type, worker }) => (worker ? [{ type, concurrency: worker.concurrency }] : [])),
      warnings: [
        ...(branch ? branchNotice(branch, apiUrl(topology)) : []),
        ...(devApp.warning ? [devApp.warning] : []),
        ...runtime.warnings,
      ],
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
    if (branchBase) await stopSixbProviders(branchBase)
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

/**
 * This git branch on the copy the supervisor fetched, or the one it reused, run as the person who
 * took it. No production session here: the branch reaches production only with its own credential.
 */
async function openBranch(
  host: LoadedSixbHost,
  projectRoot: string,
  topology: BrowserTopology,
  onLoading: (done: boolean) => void
): Promise<BranchFromProduction> {
  // Every request runs as that person, unauthenticated: only this machine may send them.
  const exposed = exposedBeyondThisMachine(topology)
  if (exposed.length > 0) {
    throw new Error(
      `[SixbCLI] A branch from production listens on this machine only, since every request runs as you: drop ${exposed.join(", ")} (a flag, SIXB_API_PUBLIC_ORIGIN or SIXB_APP_PUBLIC_ORIGIN).`
    )
  }

  return branchFromProduction({
    host,
    projectRoot,
    // The branch the supervisor started: a checkout since does not change it.
    gitBranch: process.env.SIXB_BRANCH ?? (await currentGitBranch(projectRoot)),
    gitBranches: await localGitBranches(projectRoot),
    // The supervisor's startup deadline waits while the copy loads, and says so.
    onLoading,
  })
}

/** What the startup view says of a branch: where its data comes from, and what is off on it. */
function branchNotice(branch: BranchFromProduction, apiUrl: string): string[] {
  const age = Math.max(0, Math.round((Date.now() - Date.parse(branch.takenAt)) / 60_000))
  const when = age < 60 ? `${age} min ago` : `${Math.round(age / 60)} h ago`
  return [
    `Branch: production's data as you read it, ${branch.copied ? "copied now" : `copied ${when}`} (${branch.takenAt}). --refresh takes a new copy.`,
    "Off on this branch: connectors, action writebacks and effects, syncs, inbound webhooks, emails, cron schedules and directory checks. Your project's own fetch calls and the agent's web tools still go out.",
    `Run a cron schedule on this branch: sixb schedules run <id> --api-url ${apiUrl}`,
    ...(branch.lake === "in place" ? [] : [`Datasets: ${branch.lake}.`]),
    ...branch.dropped.map((gitBranch) => `Dropped the copy of deleted git branch ${gitBranch}.`),
  ]
}
