import type { LoadedPario } from "../lib/loadPario"
import { loadProductionPario } from "../lib/production"
import {
  prepareParioRuntime,
  type RunningOrchestratorRuntime,
  runUntilSignal,
  startOrchestratorRuntime,
  stopParioProviders,
  stopQuietly,
} from "../lib/runtime"
import { ErrorView, LoadingView, RoleView, renderPersistent, renderStatic } from "../ui"

export interface OrchestratorOptions {
  entry?: string
}

export async function runOrchestrator(options: OrchestratorOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionPario({ entry: options.entry })
  const app = renderPersistent(
    <LoadingView
      title="Starting pario orchestrator"
      subtitle={loaded.entry}
      status="Starting orchestrator"
    />
  )

  let pario: LoadedPario | null = loaded.pario
  let runtime: RunningOrchestratorRuntime | null = null

  try {
    await prepareParioRuntime(pario)
    runtime = await startOrchestratorRuntime(pario)

    const warnings = [...runtime.warnings]
    if (runtime.orchestratorWorker === null) {
      warnings.push("No orchestrator routes are registered; the orchestrator process is idle.")
    }

    app.rerender(
      <RoleView
        title="Pario orchestrator started"
        name={pario.id}
        serviceName="Orchestrator"
        items={[{ label: "Role", value: "event-to-queue dispatcher" }]}
        warnings={warnings}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down orchestrator...")
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
