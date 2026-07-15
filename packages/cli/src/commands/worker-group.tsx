import type { Worker } from "@sixb/core/internal/workers"
import { type LoadedSixb, loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import {
  runUntilSignal,
  stopQuietly,
  stopSixbProviders,
  waitForWorkerFailure,
} from "../lib/runtime"
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

  let sixb: LoadedSixb | null = null
  let workers: Worker[] = []

  async function stopWorkersAndProviders() {
    await Promise.all(workers.map((worker) => stopQuietly(() => worker.stop())))
    if (sixb) {
      await stopSixbProviders(sixb)
    }
  }

  try {
    sixb = await loadSixbFromEntry(entry)

    if (usesInMemoryQueues(sixb)) {
      throw new Error(
        "[SixbWorkerGroup] `sixb worker-group` requires a queue provider that can be shared across processes. `InMemoryQueues` is for `sixb dev` only."
      )
    }

    const workerTypes =
      requestedTypes.length > 0 ? requestedTypes : resolveRegisteredWorkerTypes(sixb)

    app.rerender(
      <LoadingView title="Starting sixb worker group" subtitle={entry} status="Starting workers" />
    )

    workers = workerTypes.map((workerType) =>
      createWorkerForType(sixb as LoadedSixb, workerType, {
        agentApiBaseUrl: options.apiPublicOrigin,
      })
    )
    await Promise.all(workers.map((worker) => worker.start()))

    const warnings =
      workerTypes.length === 0
        ? ["No queue worker types are registered; the worker group process is idle."]
        : []

    app.rerender(<WorkerGroupView name={sixb.id} workerTypes={workerTypes} warnings={warnings} />)

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
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
