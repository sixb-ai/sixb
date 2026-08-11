import type { Worker } from "@sixb/core/internal/workers"
import { type LoadedSixbHost, loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import {
  runUntilSignal,
  stopQuietly,
  stopSixbProviders,
  waitForWorkerFailure,
} from "../lib/runtime"
import { assertShareableProviders } from "../lib/shareable-providers"
import { migrateStorageForRole } from "../lib/storage-migration"
import {
  assertWorkerInputs,
  createWorkerForType,
  resolveRegisteredWorkerTypes,
  resolveWorkerTypeToStart,
} from "../lib/worker-registry"
import { LoadingView, renderCliError, renderPersistent, WorkerGroupView } from "../ui"

export interface WorkerGroupOptions {
  entry?: string
  noMigrate?: boolean
  workerTypes?: readonly string[]
  apiPublicOrigin?: string
}

export async function runWorkerGroup(options: WorkerGroupOptions = {}) {
  process.env.NODE_ENV = "production"

  // Validate explicit worker types before loading the runtime so an unknown type
  // fails fast, just like `sixb worker`.
  const requestedTypes = (options.workerTypes ?? []).map(resolveWorkerTypeToStart)
  const entry = await resolveRuntimeEntry({ entry: options.entry })

  const app = renderPersistent(
    <LoadingView title="Starting sixb worker group" subtitle={entry} status="Loading runtime" />
  )

  let sixb: LoadedSixbHost | null = null
  let workers: Worker[] = []

  async function stopWorkersAndProviders() {
    await Promise.all(workers.map((worker) => stopQuietly(() => worker.stop())))
    if (sixb) {
      await stopSixbProviders(sixb)
    }
  }

  try {
    sixb = await loadSixbFromEntry(entry)

    assertShareableProviders(sixb, "worker-group")

    const workerTypes =
      requestedTypes.length > 0 ? requestedTypes : resolveRegisteredWorkerTypes(sixb)

    // Before the `map()` below, which constructs them: one unconstructable type used to throw
    // from inside that map, so the operator heard about the first problem and never learned it
    // had taken every other worker down. And before the migration, which used to run first and
    // leave a schema behind on a command that then refused.
    assertWorkerInputs({
      workerTypes,
      options: { agentApiBaseUrl: options.apiPublicOrigin },
      autoSelected: requestedTypes.length === 0,
    })

    const migration = await migrateStorageForRole(sixb, {
      role: "worker-group",
      noMigrate: options.noMigrate,
      onStart: () =>
        app.rerender(
          <LoadingView
            title="Starting sixb worker group"
            subtitle={entry}
            status="Migrating storage"
          />
        ),
    })

    app.rerender(
      <LoadingView title="Starting sixb worker group" subtitle={entry} status="Starting workers" />
    )

    const host = sixb
    workers = workerTypes.map((workerType) =>
      createWorkerForType(host, workerType, {
        agentApiBaseUrl: options.apiPublicOrigin,
      })
    )
    await Promise.all(workers.map((worker) => worker.start()))

    const warnings =
      workerTypes.length === 0
        ? ["No queue worker types are registered; the worker group process is idle."]
        : []

    app.rerender(
      <WorkerGroupView
        name={sixb.id}
        workerTypes={workerTypes}
        storage={migration.summary}
        warnings={warnings}
      />
    )

    await Promise.race([
      runUntilSignal(async () => {
        app.unmount()
        console.log("\nShutting down worker group...")
        await stopWorkersAndProviders()
        sixb = null
      }),
      ...workers.map(waitForWorkerFailure),
    ])
  } catch (error) {
    app.unmount()
    await stopWorkersAndProviders()
    await renderCliError(error)
    process.exit(1)
  }
}
