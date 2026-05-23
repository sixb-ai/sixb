import type { LoadedSixb } from "../lib/loadSixb"
import { loadProductionSixb } from "../lib/production"
import {
  type RunningOrchestratorRuntime,
  runUntilSignal,
  startOrchestratorRuntime,
  stopQuietly,
  stopSixbProviders,
} from "../lib/runtime"
import { ErrorView, LoadingView, RoleView, renderPersistent, renderStatic } from "../ui"

export interface OrchestratorOptions {
  entry?: string
}

export async function runOrchestrator(options: OrchestratorOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionSixb({ entry: options.entry })
  const app = renderPersistent(
    <LoadingView
      title="Starting sixb orchestrator"
      subtitle={loaded.entry}
      status="Starting orchestrator"
    />
  )

  let sixb: LoadedSixb | null = loaded.sixb
  let runtime: RunningOrchestratorRuntime | null = null

  try {
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
        warnings={warnings}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down orchestrator...")
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
