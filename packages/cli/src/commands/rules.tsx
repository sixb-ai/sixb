import type { LoadedPario } from "../lib/loadPario"
import { loadProductionPario } from "../lib/production"
import {
  prepareParioRuntime,
  type RunningRulesRuntime,
  runUntilSignal,
  startRulesRuntime,
  stopParioProviders,
  stopQuietly,
} from "../lib/runtime"
import { ErrorView, LoadingView, RoleView, renderPersistent, renderStatic } from "../ui"

export interface RulesOptions {
  entry?: string
}

export async function runRules(options: RulesOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionPario({ entry: options.entry })
  const app = renderPersistent(
    <LoadingView title="Starting pario rules" subtitle={loaded.entry} status="Starting rules" />
  )

  let pario: LoadedPario | null = loaded.pario
  let runtime: RunningRulesRuntime | null = null

  try {
    await prepareParioRuntime(pario)
    runtime = await startRulesRuntime(pario)

    const warnings =
      runtime.rulesWorker === null ? ["No rules are registered; the rules process is idle."] : []

    app.rerender(
      <RoleView
        title="Pario rules started"
        name={pario.id}
        serviceName="Rules"
        items={[{ label: "Role", value: "rules evaluation" }]}
        warnings={warnings}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down rules...")
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
