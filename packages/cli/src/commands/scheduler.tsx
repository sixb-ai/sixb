import type { LoadedPario } from "../lib/loadPario"
import { loadProductionPario } from "../lib/production"
import {
  type RunningSchedulerRuntime,
  runUntilSignal,
  startSchedulerRuntime,
  stopParioProviders,
  stopQuietly,
} from "../lib/runtime"
import { ErrorView, LoadingView, RoleView, renderPersistent, renderStatic } from "../ui"

export interface SchedulerOptions {
  entry?: string
}

export async function runScheduler(options: SchedulerOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionPario({ entry: options.entry })
  const app = renderPersistent(
    <LoadingView
      title="Starting pario scheduler"
      subtitle={loaded.entry}
      status="Starting scheduler"
    />
  )

  let pario: LoadedPario | null = loaded.pario
  let runtime: RunningSchedulerRuntime | null = null

  try {
    runtime = await startSchedulerRuntime(pario)

    app.rerender(
      <RoleView
        title="Pario scheduler started"
        name={pario.id}
        serviceName="Scheduler"
        items={[{ label: "Role", value: "schedule event producer" }]}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down scheduler...")
      await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
      if (pario) {
        await stopParioProviders(pario)
      }
      pario = null
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
    if (pario) {
      await stopParioProviders(pario)
    }
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
