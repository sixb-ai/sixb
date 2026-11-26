import type { LoadedSixbHost } from "../lib/loadSixb"
import { loadProductionSixb } from "../lib/production"
import { runUntilSignal, stopQuietly } from "../lib/role-lifecycle"
import {
  type RunningRulesRuntime,
  startRulesRuntime,
  stopSixbProviders,
  waitForWorkerFailure,
} from "../lib/runtime"
import { migrateStorageForRole } from "../lib/storage-migration"
import { printStopping, renderCliError, renderStatic, roleView, startTask } from "../ui"

export interface RulesOptions {
  entry?: string
  noMigrate?: boolean
}

export async function runRules(options: RulesOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionSixb({ entry: options.entry, role: "rules" })
  const app = startTask("rules", "Starting rules")

  let sixb: LoadedSixbHost | null = loaded.sixb
  let runtime: RunningRulesRuntime | null = null

  try {
    const migration = await migrateStorageForRole(sixb, {
      role: "rules",
      noMigrate: options.noMigrate,
      onStart: () => app.step("Migrating storage"),
    })

    runtime = await startRulesRuntime(sixb)

    const warnings =
      runtime.rulesWorker === null ? ["No rules are registered; the rules process is idle."] : []

    app.stop()
    await renderStatic(
      roleView({
        command: "rules",
        name: sixb.id,
        items: [{ label: "role", value: "rules evaluation" }],
        storage: migration.summary,
        warnings,
      })
    )

    await Promise.race([
      runUntilSignal(async () => {
        app.stop()
        printStopping("rules")
        await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
        if (sixb) {
          await stopSixbProviders(sixb)
        }
        sixb = null
      }),
      waitForWorkerFailure(runtime.rulesWorker),
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
