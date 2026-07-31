import type { LoadedSixb } from "../lib/loadSixb"
import { loadProductionSixb } from "../lib/production"
import {
  type RunningSchedulerRuntime,
  runUntilSignal,
  startSchedulerRuntime,
  stopQuietly,
  stopSixbProviders,
} from "../lib/runtime"
import { migrateStorageForRole } from "../lib/storage-migration"
import { ErrorView, LoadingView, RoleView, renderPersistent, renderStatic } from "../ui"

export interface SchedulerOptions {
  entry?: string
  noMigrate?: boolean
}

export async function runScheduler(options: SchedulerOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionSixb({ entry: options.entry, role: "scheduler" })
  const app = renderPersistent(
    <LoadingView
      title="Starting sixb scheduler"
      subtitle={loaded.entry}
      status="Starting scheduler"
    />
  )

  let sixb: LoadedSixb | null = loaded.sixb
  let runtime: RunningSchedulerRuntime | null = null

  try {
    const migration = await migrateStorageForRole(sixb, {
      role: "scheduler",
      noMigrate: options.noMigrate,
      onStart: () =>
        app.rerender(
          <LoadingView
            title="Starting sixb scheduler"
            subtitle={loaded.entry}
            status="Migrating storage"
          />
        ),
    })

    runtime = await startSchedulerRuntime(sixb)

    app.rerender(
      <RoleView
        title="Sixb scheduler started"
        name={sixb.id}
        serviceName="Scheduler"
        items={[{ label: "Role", value: "schedule event producer" }]}
        storage={migration.summary}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down scheduler...")
      await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
      if (sixb) {
        await stopSixbProviders(sixb)
      }
      sixb = null
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
    if (sixb) {
      await stopSixbProviders(sixb)
    }
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
