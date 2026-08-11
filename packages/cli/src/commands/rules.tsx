import type { LoadedSixbHost } from "../lib/loadSixb"
import { loadProductionSixb } from "../lib/production"
import {
  type RunningRulesRuntime,
  runUntilSignal,
  startRulesRuntime,
  stopQuietly,
  stopSixbProviders,
  waitForWorkerFailure,
} from "../lib/runtime"
import { migrateStorageForRole } from "../lib/storage-migration"
import { LoadingView, RoleView, renderCliError, renderPersistent } from "../ui"

export interface RulesOptions {
  entry?: string
  noMigrate?: boolean
}

export async function runRules(options: RulesOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionSixb({ entry: options.entry, role: "rules" })
  const app = renderPersistent(
    <LoadingView title="Starting sixb rules" subtitle={loaded.entry} status="Starting rules" />
  )

  let sixb: LoadedSixbHost | null = loaded.sixb
  let runtime: RunningRulesRuntime | null = null

  try {
    const migration = await migrateStorageForRole(sixb, {
      role: "rules",
      noMigrate: options.noMigrate,
      onStart: () =>
        app.rerender(
          <LoadingView
            title="Starting sixb rules"
            subtitle={loaded.entry}
            status="Migrating storage"
          />
        ),
    })

    runtime = await startRulesRuntime(sixb)

    const warnings =
      runtime.rulesWorker === null ? ["No rules are registered; the rules process is idle."] : []

    app.rerender(
      <RoleView
        title="Sixb rules started"
        name={sixb.id}
        serviceName="Rules"
        items={[{ label: "Role", value: "rules evaluation" }]}
        storage={migration.summary}
        warnings={warnings}
      />
    )

    await Promise.race([
      runUntilSignal(async () => {
        app.unmount()
        console.log("\nShutting down rules...")
        await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
        if (sixb) {
          await stopSixbProviders(sixb)
        }
        sixb = null
      }),
      waitForWorkerFailure(runtime.rulesWorker),
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
