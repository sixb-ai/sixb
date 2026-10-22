import type { LoadedSixbHost } from "../lib/loadSixb"
import { loadProductionSixb } from "../lib/production"
import { runUntilSignal, stopQuietly } from "../lib/role-lifecycle"
import {
  type RunningSchedulerRuntime,
  startSchedulerRuntime,
  stopSixbProviders,
} from "../lib/runtime"
import { migrateStorageForRole } from "../lib/storage-migration"
import { printStopping, renderCliError, renderStatic, roleView, startTask } from "../ui"

export interface SchedulerOptions {
  entry?: string
  noMigrate?: boolean
}

export async function runScheduler(options: SchedulerOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionSixb({ entry: options.entry, role: "scheduler" })
  const app = startTask("scheduler", "Starting scheduler")

  let sixb: LoadedSixbHost | null = loaded.sixb
  let runtime: RunningSchedulerRuntime | null = null

  try {
    const migration = await migrateStorageForRole(sixb, {
      role: "scheduler",
      noMigrate: options.noMigrate,
      onStart: () => app.step("Migrating storage"),
    })

    runtime = await startSchedulerRuntime(sixb)

    app.stop()
    await renderStatic(
      roleView({
        command: "scheduler",
        name: sixb.id,
        items: [{ label: "role", value: "schedule event producer" }],
        storage: migration.summary,
      })
    )

    await runUntilSignal(async () => {
      app.stop()
      printStopping("scheduler")
      await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
      if (sixb) {
        await stopSixbProviders(sixb)
      }
      sixb = null
    })
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
