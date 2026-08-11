import type { LoadedSixbHost } from "../lib/loadSixb"
import { loadProductionSixb } from "../lib/production"
import {
  type RunningOrchestratorRuntime,
  runUntilSignal,
  startOrchestratorRuntime,
  stopQuietly,
  stopSixbProviders,
  waitForWorkerFailure,
} from "../lib/runtime"
import { migrateStorageForRole } from "../lib/storage-migration"
import { LoadingView, RoleView, renderCliError, renderPersistent } from "../ui"

export interface OrchestratorOptions {
  entry?: string
  noMigrate?: boolean
}

export async function runOrchestrator(options: OrchestratorOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionSixb({ entry: options.entry, role: "orchestrator" })
  const app = renderPersistent(
    <LoadingView
      title="Starting sixb orchestrator"
      subtitle={loaded.entry}
      status="Starting orchestrator"
    />
  )

  let sixb: LoadedSixbHost | null = loaded.sixb
  let runtime: RunningOrchestratorRuntime | null = null

  try {
    const migration = await migrateStorageForRole(sixb, {
      role: "orchestrator",
      noMigrate: options.noMigrate,
      onStart: () =>
        app.rerender(
          <LoadingView
            title="Starting sixb orchestrator"
            subtitle={loaded.entry}
            status="Migrating storage"
          />
        ),
    })

    runtime = await startOrchestratorRuntime(sixb)

    const warnings = [...runtime.warnings]
    if (runtime.orchestratorWorker === null) {
      warnings.push("No orchestrator routes are registered; the orchestrator process is idle.")
    }

    app.rerender(
      <RoleView
        title="Sixb orchestrator started"
        name={sixb.id}
        serviceName="Orchestrator"
        items={[{ label: "Role", value: "event-to-queue dispatcher" }]}
        storage={migration.summary}
        warnings={warnings}
      />
    )

    await Promise.race([
      runUntilSignal(async () => {
        app.unmount()
        console.log("\nShutting down orchestrator...")
        await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
        if (sixb) {
          await stopSixbProviders(sixb)
        }
        sixb = null
      }),
      waitForWorkerFailure(runtime.orchestratorWorker),
    ])
  } catch (error) {
    app.unmount()
    await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
    if (sixb) {
      await stopSixbProviders(sixb)
    }
    await renderCliError(error)
    process.exit(1)
  }
}
