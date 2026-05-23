import type { LoadedSixb } from "../lib/loadSixb"
import { loadProductionSixb } from "../lib/production"
import {
  type RunningFunctionsRuntime,
  runUntilSignal,
  startFunctionsRuntime,
  stopQuietly,
  stopSixbProviders,
} from "../lib/runtime"
import { ErrorView, LoadingView, RoleView, renderPersistent, renderStatic } from "../ui"

export interface FunctionsOptions {
  entry?: string
}

export async function runFunctions(options: FunctionsOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionSixb({ entry: options.entry })
  const app = renderPersistent(
    <LoadingView
      title="Starting sixb functions"
      subtitle={loaded.entry}
      status="Starting functions"
    />
  )

  let sixb: LoadedSixb | null = loaded.sixb
  let runtime: RunningFunctionsRuntime | null = null

  try {
    runtime = await startFunctionsRuntime(sixb)

    app.rerender(
      <RoleView
        title="Sixb functions started"
        name={sixb.id}
        serviceName="Functions"
        items={[{ label: "Role", value: "registered functions" }]}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down functions...")
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
