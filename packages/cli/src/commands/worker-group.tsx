import type { Worker } from "@pario/core"
import { type LoadedPario, loadParioFromEntry } from "../lib/loadPario"
import { resolveRuntimeEntry } from "../lib/production"
import { runUntilSignal, stopParioProviders, stopQuietly } from "../lib/runtime"
import {
  createWorkerForType,
  resolveRegisteredWorkerTypes,
  resolveWorkerTypeToStart,
  usesInMemoryQueues,
} from "../lib/worker-registry"
import { ErrorView, LoadingView, renderPersistent, renderStatic, WorkerGroupView } from "../ui"

export interface WorkerGroupOptions {
  entry?: string
  workerTypes?: readonly string[]
}

export async function runWorkerGroup(options: WorkerGroupOptions = {}) {
  process.env.NODE_ENV = "production"

  // Validate explicit worker types before loading the runtime so an unknown type
  // fails fast, just like `pario worker`.
  const requestedTypes = (options.workerTypes ?? []).map(resolveWorkerTypeToStart)
  const entry = await resolveRuntimeEntry({ entry: options.entry })

  const app = renderPersistent(
    <LoadingView title="Starting pario worker group" subtitle={entry} status="Loading runtime" />
  )

  let pario: LoadedPario | null = null
  let workers: Worker[] = []

  async function stopWorkersAndProviders() {
    await Promise.all(workers.map((worker) => stopQuietly(() => worker.stop())))
    if (pario) {
      await stopParioProviders(pario)
    }
  }

  try {
    pario = await loadParioFromEntry(entry)

    if (usesInMemoryQueues(pario)) {
      throw new Error(
        "[ParioWorkerGroup] `pario worker-group` requires a queue provider that can be shared across processes. `InMemoryQueues` is for `pario dev` only."
      )
    }

    const workerTypes =
      requestedTypes.length > 0 ? requestedTypes : resolveRegisteredWorkerTypes(pario)

    app.rerender(
      <LoadingView title="Starting pario worker group" subtitle={entry} status="Starting workers" />
    )

    workers = workerTypes.map((workerType) => createWorkerForType(pario as LoadedPario, workerType))
    await Promise.all(workers.map((worker) => worker.start()))

    const warnings =
      workerTypes.length === 0
        ? ["No queue worker types are registered; the worker group process is idle."]
        : []

    app.rerender(<WorkerGroupView name={pario.id} workerTypes={workerTypes} warnings={warnings} />)

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down worker group...")
      await stopWorkersAndProviders()
      pario = null
    })
  } catch (error) {
    app.unmount()
    await stopWorkersAndProviders()
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
