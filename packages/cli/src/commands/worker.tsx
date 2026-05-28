import { InMemoryQueues, type Worker } from "@pario/core"
import { type LoadedPario, loadParioFromEntry } from "../lib/loadPario"
import { resolveRuntimeEntry } from "../lib/production"
import { prepareParioRuntime, runUntilSignal, stopQuietly } from "../lib/runtime"
import { createWorkerForType, resolveWorkerTypeToStart } from "../lib/worker-registry"
import { ErrorView, LoadingView, renderPersistent, renderStatic, WorkerView } from "../ui"

export interface WorkerOptions {
  entry?: string
  workerType?: string
}

function usesInMemoryQueues(pario: LoadedPario): boolean {
  const queues = pario.queues as { constructor?: { name?: string }; provider?: unknown }
  return queues instanceof InMemoryQueues || queues.provider === "in-memory"
}

export async function runWorker(options: WorkerOptions = {}) {
  process.env.NODE_ENV = "production"

  const workerType = resolveWorkerTypeToStart(options.workerType)
  const entry = await resolveRuntimeEntry({ entry: options.entry })

  const app = renderPersistent(
    <LoadingView title="Starting pario worker" subtitle={entry} status="Loading runtime" />
  )

  let pario: LoadedPario | null = null
  let worker: Worker | null = null

  try {
    pario = await loadParioFromEntry(entry)

    if (usesInMemoryQueues(pario)) {
      throw new Error(
        "[ParioWorker] `pario worker` requires a queue provider that can be shared across processes. `InMemoryQueues` is for `pario dev` only."
      )
    }

    app.rerender(
      <LoadingView title="Starting pario worker" subtitle={entry} status="Running migrations" />
    )
    await prepareParioRuntime(pario)

    app.rerender(
      <LoadingView title="Starting pario worker" subtitle={entry} status="Starting worker" />
    )

    worker = createWorkerForType(pario, workerType)
    await worker.start()

    const workerId = `${workerType}-worker-${pario.id}`
    app.rerender(<WorkerView name={pario.id} workerId={workerId} />)

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down worker...")
      await stopQuietly(() => worker?.stop() ?? Promise.resolve())
      await stopQuietly(() => pario?.disconnectConnectors() ?? Promise.resolve())
      await stopQuietly(() => pario?.closeBroker() ?? Promise.resolve())
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => worker?.stop() ?? Promise.resolve())
    await stopQuietly(() => pario?.disconnectConnectors() ?? Promise.resolve())
    await stopQuietly(() => pario?.closeBroker() ?? Promise.resolve())
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
