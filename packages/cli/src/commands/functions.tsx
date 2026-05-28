import type { LoadedPario } from "../lib/loadPario"
import { loadProductionPario } from "../lib/production"
import {
  prepareParioRuntime,
  type RunningFunctionsRuntime,
  runUntilSignal,
  startFunctionsRuntime,
  stopParioProviders,
  stopQuietly,
} from "../lib/runtime"
import { ErrorView, LoadingView, RoleView, renderPersistent, renderStatic } from "../ui"

export interface FunctionsOptions {
  entry?: string
}

export async function runFunctions(options: FunctionsOptions = {}) {
  process.env.NODE_ENV = "production"

  const loaded = await loadProductionPario({ entry: options.entry })
  const app = renderPersistent(
    <LoadingView
      title="Starting pario functions"
      subtitle={loaded.entry}
      status="Starting functions"
    />
  )

  let pario: LoadedPario | null = loaded.pario
  let runtime: RunningFunctionsRuntime | null = null

  try {
    await prepareParioRuntime(pario)
    runtime = await startFunctionsRuntime(pario)

    app.rerender(
      <RoleView
        title="Pario functions started"
        name={pario.id}
        serviceName="Functions"
        items={[{ label: "Role", value: "registered functions" }]}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down functions...")
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
