import type { LoadedSixbHost } from "../lib/loadSixb"
import { loadProductionSixb } from "../lib/production"
import { runUntilSignal, stopQuietly } from "../lib/role-lifecycle"
import {
  type RunningOrchestratorRuntime,
  startOrchestratorRuntime,
  stopSixbProviders,
  waitForWorkerFailure,
} from "../lib/runtime"
import { migrateStorageForRole } from "../lib/storage-migration"
import { printStopping, renderCliError, renderStatic, roleView, startTask } from "../ui"

export interface OrchestratorOptions {
  entry?: string
  noMigrate?: boolean
}

export async function runOrchestrator(options: OrchestratorOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionSixb({ entry: options.entry, role: "orchestrator" })
  const app = startTask("orchestrator", "Starting orchestrator")

  let sixb: LoadedSixbHost | null = loaded.sixb
  let runtime: RunningOrchestratorRuntime | null = null

  try {
    const migration = await migrateStorageForRole(sixb, {
      role: "orchestrator",
      noMigrate: options.noMigrate,
      onStart: () => app.step("Migrating storage"),
    })

    runtime = await startOrchestratorRuntime(sixb)

    const warnings = [...runtime.warnings]
    if (runtime.orchestratorWorker === null) {
      warnings.push("No orchestrator routes are registered; the orchestrator process is idle.")
    }

    app.stop()
    await renderStatic(
      roleView({
        command: "orchestrator",
        name: sixb.id,
        items: [{ label: "role", value: "event-to-queue dispatcher" }],
        storage: migration.summary,
        warnings,
      })
    )

    await Promise.race([
      runUntilSignal(async () => {
        app.stop()
        printStopping("orchestrator")
        await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
        if (sixb) {
          await stopSixbProviders(sixb)
        }
        sixb = null
      }),
      waitForWorkerFailure(runtime.orchestratorWorker),
    ])
  } catch (error) {
    app.stop()
    await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
    if (sixb) {
      await stopSixbProviders(sixb)
    }
    await renderCliError(error)
    process.exit(1)
  }
}
