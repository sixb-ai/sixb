import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import {
  assertLakeDatasetDefinitionsCompatible,
  InMemoryQueues,
  migrateStorage,
  type Worker,
} from "@pario/core"
import { type LoadedPario, loadParioFromEntry } from "../lib/loadPario"
import { runUntilSignal, stopQuietly } from "../lib/runtime"
import { createWorkerForType, resolveWorkerTypesToStart } from "../lib/worker-registry"
import { ErrorView, LoadingView, renderPersistent, renderStatic, WorkerView } from "../ui"

export interface WorkerOptions {
  entry?: string
  worker?: string
}

function usesInMemoryQueues(pario: LoadedPario): boolean {
  const queues = pario.queues as { constructor?: { name?: string }; provider?: unknown }
  return queues instanceof InMemoryQueues || queues.provider === "in-memory"
}

export async function runWorker(options: WorkerOptions = {}) {
  process.env.NODE_ENV = "production"

  const sourceEntry = resolve("pario.config.ts")
  const defaultBuiltEntry = resolve(".pario/dist/pario.config.js")

  let entry = sourceEntry
  if (options.entry) {
    entry = resolve(options.entry)
  } else {
    const builtInfo = await stat(defaultBuiltEntry).catch(() => null)
    entry = builtInfo ? defaultBuiltEntry : sourceEntry
  }

  const app = renderPersistent(
    <LoadingView title="Starting pario worker" subtitle={entry} status="Loading runtime" />
  )

  let pario: LoadedPario | null = null
  const workers: Worker[] = []

  try {
    pario = await loadParioFromEntry(entry)
    const requestedWorkers = resolveWorkerTypesToStart(pario, options.worker)

    if (usesInMemoryQueues(pario)) {
      throw new Error(
        "[ParioWorker] `pario worker` requires a queue provider that can be shared across processes. `InMemoryQueues` is for `pario dev` only."
      )
    }

    app.rerender(
      <LoadingView title="Starting pario worker" subtitle={entry} status="Running migrations" />
    )
    await migrateStorage(pario.storage)

    app.rerender(
      <LoadingView
        title="Starting pario worker"
        subtitle={entry}
        status="Checking lake definitions"
      />
    )
    await assertLakeDatasetDefinitionsCompatible({
      lakeStorage: pario.lakeStorage,
      definitions: pario.getDatasetDefinitions(),
    })

    app.rerender(
      <LoadingView title="Starting pario worker" subtitle={entry} status="Starting worker" />
    )

    for (const workerType of requestedWorkers) {
      workers.push(createWorkerForType(pario, workerType))
    }

    await Promise.all(workers.map((w) => w.start()))

    const workerId = options.worker
      ? `${options.worker}-worker-${pario.id}`
      : `all-workers-${pario.id}`
    app.rerender(<WorkerView name={pario.id} workerId={workerId} />)

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down worker...")
      await Promise.all(workers.map((w) => stopQuietly(() => w.stop())))
      await stopQuietly(() => pario?.disconnectConnectors() ?? Promise.resolve())
      await stopQuietly(() => pario?.closeBroker() ?? Promise.resolve())
    })
  } catch (error) {
    app.unmount()
    await Promise.all(workers.map((w) => stopQuietly(() => w.stop())))
    await stopQuietly(() => pario?.disconnectConnectors() ?? Promise.resolve())
    await stopQuietly(() => pario?.closeBroker() ?? Promise.resolve())
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
