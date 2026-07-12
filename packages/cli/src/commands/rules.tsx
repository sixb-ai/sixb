import type { LoadedSixb } from "../lib/loadSixb"
import { loadProductionSixb } from "../lib/production"
import {
  type RunningRulesRuntime,
  runUntilSignal,
  startRulesRuntime,
  stopQuietly,
  stopSixbProviders,
  waitForWorkerFailure,
} from "../lib/runtime"
import { ErrorView, LoadingView, RoleView, renderPersistent, renderStatic } from "../ui"

export interface RulesOptions {
  entry?: string
}

export async function runRules(options: RulesOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionSixb({ entry: options.entry })
  const app = renderPersistent(
    <LoadingView title="Starting sixb rules" subtitle={loaded.entry} status="Starting rules" />
  )

  let sixb: LoadedSixb | null = loaded.sixb
  let runtime: RunningRulesRuntime | null = null

  try {
    runtime = await startRulesRuntime(sixb)

    const warnings =
      runtime.rulesWorker === null ? ["No rules are registered; the rules process is idle."] : []

    app.rerender(
      <RoleView
        title="Sixb rules started"
        name={sixb.id}
        serviceName="Rules"
        items={[{ label: "Role", value: "rules evaluation" }]}
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
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
