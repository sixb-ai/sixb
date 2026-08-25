import type { Worker } from "@sixb/core/internal/workers"
import { resolveAgentTurnTimeoutMs } from "../lib/agent-turn-timeout"
import { SixbCliError } from "../lib/errors"
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
  createWorkerForType,
  resolveWorkerTypeToStart,
  unmetWorkerRequirement,
} from "../lib/worker-registry"
import { LoadingView, renderCliError, renderPersistent, WorkerView } from "../ui"

export interface WorkerOptions {
  entry?: string
  noMigrate?: boolean
  workerType?: string
  apiPublicOrigin?: string
  agentTurnTimeout?: string
}

export async function runWorker(options: WorkerOptions = {}) {
  process.env.NODE_ENV = "production"

  const workerType = resolveWorkerTypeToStart(options.workerType)
  const agentTurnTimeoutMs = resolveAgentTurnTimeoutMs(options.agentTurnTimeout)
  const entry = await resolveRuntimeEntry({ entry: options.entry })

  const app = renderPersistent(
    <LoadingView title="Starting sixb worker" subtitle={entry} status="Loading runtime" />
  )

  let sixb: LoadedSixbHost | null = null
  let worker: Worker | null = null

  try {
    sixb = await loadSixbFromEntry(entry)

    assertShareableProviders(sixb, "worker")

    // Before the migration, which is the first thing here that changes something: this used to
    // bring the schema up to date and then refuse to run.
    const unmet = unmetWorkerRequirement(workerType, {
      agentApiBaseUrl: options.apiPublicOrigin,
    })
    if (unmet) {
      throw new SixbCliError(`[SixbCLI] \`sixb worker ${workerType}\` cannot start: it ${unmet}.`)
    }

    const migration = await migrateStorageForRole(sixb, {
      role: "worker",
      noMigrate: options.noMigrate,
      onStart: () =>
        app.rerender(
          <LoadingView title="Starting sixb worker" subtitle={entry} status="Migrating storage" />
        ),
    })

    app.rerender(
      <LoadingView title="Starting sixb worker" subtitle={entry} status="Starting worker" />
    )

    worker = createWorkerForType(sixb, workerType, {
      agentApiBaseUrl: options.apiPublicOrigin,
      agentTurnTimeoutMs,
    })
    await worker.start()

    const workerId = `${workerType}-worker-${sixb.id}`
    app.rerender(<WorkerView name={sixb.id} workerId={workerId} storage={migration.summary} />)

    await Promise.race([
      runUntilSignal(async () => {
        app.unmount()
        console.log("\nShutting down worker...")
        await stopQuietly(() => worker?.stop() ?? Promise.resolve())
        if (sixb) {
          await stopSixbProviders(sixb)
        }
        sixb = null
      }),
      waitForWorkerFailure(worker),
    ])
  } catch (error) {
    app.unmount()
    await stopQuietly(() => worker?.stop() ?? Promise.resolve())
    if (sixb) {
      await stopSixbProviders(sixb)
    }
    await renderCliError(error)
    process.exit(1)
  }
}
