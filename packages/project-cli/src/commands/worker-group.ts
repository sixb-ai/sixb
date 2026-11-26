import { type LoadedSixbHost, loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import { resolveDrainTimeoutMs, runUntilSignal, stopQuietly } from "../lib/role-lifecycle"

// Leaves 10 s inside the default 70 s kill timeout for abort finalization and provider shutdown.
const DEFAULT_WORKER_DRAIN_TIMEOUT_MS = 60_000

import { recordApiPublicOrigin, stopSixbProviders, waitForWorkerFailure } from "../lib/runtime"
import { assertShareableProviders } from "../lib/shareable-providers"
import { migrateStorageForRole } from "../lib/storage-migration"
import {
  resolveSubagentConcurrency,
  resolveVectorConcurrency,
  resolveWorkerConcurrency,
} from "../lib/worker-concurrency"
import {
  agentRuntimeRequired,
  assertWorkerInputs,
  createWorkerForType,
  omittedWorkerWarnings,
  type QueueWorkerProcess,
  resolveRegisteredWorkerTypes,
  resolveWorkerTypeToStart,
} from "../lib/worker-registry"
import {
  printStopping,
  renderCliError,
  renderStatic,
  roleView,
  startTask,
  workerItems,
} from "../ui"

export interface WorkerGroupOptions {
  entry?: string
  noMigrate?: boolean
  workerTypes?: readonly string[]
  apiPublicOrigin?: string
  concurrency?: readonly string[]
  vectorConcurrency?: string
  subagentConcurrency?: string
  subagentConcurrencyPerRun?: string
}

export async function runWorkerGroup(options: WorkerGroupOptions = {}) {
  process.env.NODE_ENV = "production"

  // Validate explicit worker types before loading the runtime so an unknown type
  // fails fast, just like `sixb worker`.
  const requestedTypes = (options.workerTypes ?? []).map(resolveWorkerTypeToStart)
  const workerConcurrency = resolveWorkerConcurrency(options.concurrency)
  const vectorConcurrency = resolveVectorConcurrency(options.vectorConcurrency)
  const subagents = resolveSubagentConcurrency({
    perWorker: options.subagentConcurrency,
    perRun: options.subagentConcurrencyPerRun,
  })
  const entry = await resolveRuntimeEntry({ entry: options.entry })

  const app = startTask("worker-group", "Loading runtime")

  let sixb: LoadedSixbHost | null = null
  let workers: QueueWorkerProcess[] = []

  async function stopWorkersAndProviders(drainTimeoutMs?: number) {
    await Promise.all(
      workers.map((worker) =>
        stopQuietly(async () => {
          if (drainTimeoutMs !== undefined) {
            await worker.drain(drainTimeoutMs)
          } else {
            await worker.stop()
          }
        })
      )
    )
    if (sixb) {
      await stopSixbProviders(sixb)
    }
  }

  try {
    sixb = await loadSixbFromEntry(entry)
    recordApiPublicOrigin(sixb, options.apiPublicOrigin)

    assertShareableProviders(sixb, "worker-group")

    const workerTypes =
      requestedTypes.length > 0 ? requestedTypes : resolveRegisteredWorkerTypes(sixb)

    // Before the `map()` below, which constructs them: one unconstructable type used to throw
    // from inside that map, so the operator heard about the first problem and never learned it
    // had taken every other worker down. And before the migration, which used to run first and
    // leave a schema behind on a command that then refused.
    assertWorkerInputs({
      agentApiRequired: agentRuntimeRequired(sixb.definitions),
      workerTypes,
      options: { agentApiBaseUrl: options.apiPublicOrigin },
      autoSelected: requestedTypes.length === 0,
    })

    const migration = await migrateStorageForRole(sixb, {
      role: "worker-group",
      noMigrate: options.noMigrate,
      onStart: () => app.step("Migrating storage"),
    })

    app.step("Starting workers")

    const host = sixb
    workers = workerTypes.map((workerType) =>
      createWorkerForType(host, workerType, {
        agentApiBaseUrl: options.apiPublicOrigin,
        workerConcurrency,
        vectorConcurrency,
        ...subagents,
      })
    )
    await Promise.all(workers.map((worker) => worker.start()))

    const warnings = [
      ...(workerTypes.length === 0
        ? ["No queue worker types are registered; the worker group process is idle."]
        : []),
      ...omittedWorkerWarnings(host, workerTypes),
    ]

    app.stop()
    await renderStatic(
      roleView({
        command: "worker-group",
        name: sixb.id,
        items: workerItems(
          workerTypes.map((workerType, index) => ({
            type: workerType,
            concurrency: workers[index]?.concurrency ?? 1,
          }))
        ),
        storage: migration.summary,
        warnings,
      })
    )

    await Promise.race([
      runUntilSignal(
        async (signal) => {
          app.stop()
          printStopping("worker-group")
          const drainTimeoutMs =
            signal === "SIGTERM"
              ? resolveDrainTimeoutMs(DEFAULT_WORKER_DRAIN_TIMEOUT_MS)
              : undefined
          await stopWorkersAndProviders(drainTimeoutMs)
          sixb = null
        },
        {
          onInterrupt: () => {
            for (const worker of workers) {
              void stopQuietly(() => worker.stop())
            }
          },
        }
      ),
      ...workers.map(waitForWorkerFailure),
    ])
  } catch (error) {
    app.stop()
    await stopWorkersAndProviders()
    await renderCliError(error)
    process.exit(1)
  }
}
