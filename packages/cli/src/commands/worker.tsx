import type { Worker } from "@sixb/core"
import { type LoadedSixb, loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import { runUntilSignal, stopQuietly, stopSixbProviders } from "../lib/runtime"
import {
  createWorkerForType,
  resolveWorkerTypeToStart,
  usesInMemoryQueues,
} from "../lib/worker-registry"
import { ErrorView, LoadingView, renderPersistent, renderStatic, WorkerView } from "../ui"

export interface WorkerOptions {
  entry?: string
  workerType?: string
  apiPublicOrigin?: string
}

export async function runWorker(options: WorkerOptions = {}) {
  process.env.NODE_ENV = "production"

  const workerType = resolveWorkerTypeToStart(options.workerType)
  const entry = await resolveRuntimeEntry({ entry: options.entry })

  const app = renderPersistent(
    <LoadingView title="Starting sixb worker" subtitle={entry} status="Loading runtime" />
  )

  let sixb: LoadedSixb | null = null
  let worker: Worker | null = null

  try {
    sixb = await loadSixbFromEntry(entry)

    if (usesInMemoryQueues(sixb)) {
      throw new Error(
        "[SixbWorker] `sixb worker` requires a queue provider that can be shared across processes. `InMemoryQueues` is for `sixb dev` only."
      )
    }

    app.rerender(
      <LoadingView title="Starting sixb worker" subtitle={entry} status="Starting worker" />
    )

    worker = createWorkerForType(sixb, workerType, {
      agentApiBaseUrl: options.apiPublicOrigin,
    })
    await worker.start()

    const workerId = `${workerType}-worker-${sixb.id}`
    app.rerender(<WorkerView name={sixb.id} workerId={workerId} />)

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down worker...")
      await stopQuietly(() => worker?.stop() ?? Promise.resolve())
      if (sixb) {
        await stopSixbProviders(sixb)
      }
      sixb = null
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => worker?.stop() ?? Promise.resolve())
    if (sixb) {
      await stopSixbProviders(sixb)
    }
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
