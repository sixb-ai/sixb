import { resolveAgentTurnTimeoutMs } from "../lib/agent-turn-timeout"
import { SixbCliError } from "../lib/errors"
import { type LoadedSixbHost, loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import { runUntilSignal, stopQuietly } from "../lib/role-lifecycle"
import { recordApiPublicOrigin, stopSixbProviders, waitForWorkerFailure } from "../lib/runtime"
import { assertShareableProviders } from "../lib/shareable-providers"
import { migrateStorageForRole } from "../lib/storage-migration"
import {
  resolveSingleWorkerConcurrency,
  resolveSubagentConcurrency,
  resolveVectorConcurrency,
} from "../lib/worker-concurrency"
import {
  agentRuntimeRequired,
  createWorkerForType,
  type QueueWorkerProcess,
  resolveWorkerTypeToStart,
  unmetWorkerRequirement,
} from "../lib/worker-registry"
import { printStopping, renderCliError, renderStatic, roleView, startTask } from "../ui"

export interface WorkerOptions {
  entry?: string
  noMigrate?: boolean
  workerType?: string
  apiPublicOrigin?: string
  agentTurnTimeout?: string
  concurrency?: string
  vectorConcurrency?: string
  subagentConcurrencyPerRun?: string
}

export async function runWorker(options: WorkerOptions = {}) {
  process.env.NODE_ENV = "production"

  const workerType = resolveWorkerTypeToStart(options.workerType)
  const agentTurnTimeoutMs = resolveAgentTurnTimeoutMs(options.agentTurnTimeout)
  const workerConcurrency = resolveSingleWorkerConcurrency(workerType, options.concurrency)
  const vectorConcurrency = resolveVectorConcurrency(options.vectorConcurrency)
  const subagents = resolveSubagentConcurrency({
    perRun: options.subagentConcurrencyPerRun,
  })
  const entry = await resolveRuntimeEntry({ entry: options.entry })

  const app = startTask("worker", "Loading runtime")

  let sixb: LoadedSixbHost | null = null
  let worker: QueueWorkerProcess | null = null

  try {
    sixb = await loadSixbFromEntry(entry)
    recordApiPublicOrigin(sixb, options.apiPublicOrigin)

    assertShareableProviders(sixb, "worker")

    // Before the migration, which is the first thing here that changes something: this used to
    // bring the schema up to date and then refuse to run.
    const unmet = unmetWorkerRequirement(
      workerType,
      {
        agentApiBaseUrl: options.apiPublicOrigin,
      },
      agentRuntimeRequired(sixb.definitions)
    )
    if (unmet) {
      throw new SixbCliError(`[SixbCLI] \`sixb worker ${workerType}\` cannot start: it ${unmet}.`)
    }

    const migration = await migrateStorageForRole(sixb, {
      role: "worker",
      noMigrate: options.noMigrate,
      onStart: () => app.step("Migrating storage"),
    })

    app.step("Starting worker")

    worker = createWorkerForType(sixb, workerType, {
      agentApiBaseUrl: options.apiPublicOrigin,
      agentTurnTimeoutMs,
      workerConcurrency,
      vectorConcurrency,
      ...subagents,
    })
    await worker.start()

    const workerId = `${workerType}-worker-${sixb.id}`
    app.stop()
    await renderStatic(
      roleView({
        command: `worker ${workerType}`,
        name: sixb.id,
        items: [
          { label: "worker", value: workerId },
          { label: "concurrency", value: String(worker.concurrency) },
        ],
        storage: migration.summary,
      })
    )

    await Promise.race([
      runUntilSignal(async () => {
        app.stop()
        printStopping("worker")
        await stopQuietly(() => worker?.stop() ?? Promise.resolve())
        if (sixb) {
          await stopSixbProviders(sixb)
        }
        sixb = null
      }),
      waitForWorkerFailure(worker),
    ])
  } catch (error) {
    app.stop()
    await stopQuietly(() => worker?.stop() ?? Promise.resolve())
    if (sixb) {
      await stopSixbProviders(sixb)
    }
    await renderCliError(error)
    process.exit(1)
  }
}
