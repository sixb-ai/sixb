import { dirname, resolve } from "node:path"
import { createParioApp } from "@pario/app"
import { createParioServer, type ParioServer } from "@pario/server"
import { type LoadedPario, loadParioFromEntry } from "../lib/loadPario"
import { runUntilSignal, startParioRuntime, stopQuietly } from "../lib/runtime"
import { DevView, ErrorView, LoadingView, renderPersistent, renderStatic } from "../ui"

export interface DevOptions {
  entry?: string
  port?: string
  appPort?: string
  host?: string
  publicOrigin?: string
  appPublicOrigin?: string
}

export async function runDev(options: DevOptions = {}) {
  process.env.NODE_ENV = "development"

  const entry = resolve(options.entry ?? "pario.config.ts")
  const port = options.port ? Number.parseInt(options.port, 10) : 3000
  const appPort = options.appPort ? Number.parseInt(options.appPort, 10) : port + 1
  const host = options.host ?? "0.0.0.0"

  const app = renderPersistent(
    <LoadingView title="Starting pario" subtitle={entry} status="Loading runtime" />
  )

  let server: ParioServer | null = null
  let customAppServer: ParioServer | null = null
  let pario: LoadedPario | null = null
  let runtime: Awaited<ReturnType<typeof startParioRuntime>> | null = null

  try {
    pario = await loadParioFromEntry(entry)
    const projectRoot = dirname(resolve(entry))

    runtime = await startParioRuntime(pario, { cohostWorkers: true })

    app.rerender(<LoadingView title="Starting pario" subtitle={entry} status="Starting server" />)

    const displayHost = host === "0.0.0.0" ? "localhost" : host
    const baseUrl = `http://${displayHost}:${port}`
    const appBaseUrl = `http://${displayHost}:${appPort}`
    let appUrl: string | null = null
    server = createParioServer({
      pario,
      port,
      host,
      quiet: true,
      surface: { kind: "builtInUi" },
      publicOrigin: options.publicOrigin ?? baseUrl,
    })
    await server.start()

    const customApp = await createParioApp({ rootDir: projectRoot })

    if (await customApp.hasRoutes()) {
      if (appPort === port) {
        throw new Error("[ParioCLI] --app-port must be different from --port.")
      }

      app.rerender(
        <LoadingView title="Starting pario" subtitle={entry} status="Starting custom app" />
      )

      customAppServer = createParioServer({
        pario,
        port: appPort,
        host,
        quiet: true,
        surface: {
          kind: "customApp",
          app: await customApp.createDevMount(),
        },
        publicOrigin: options.appPublicOrigin ?? appBaseUrl,
      })
      await customAppServer.start()
      appUrl = appBaseUrl
    }

    app.rerender(
      <DevView
        name={pario.id}
        apiUrl={`${baseUrl}/api`}
        apiDocsUrl={`${baseUrl}/docs`}
        wsUrl={`${baseUrl.replace("http", "ws")}/ws/events`}
        uiUrl={baseUrl}
        uiStatus={null}
        appUrl={appUrl}
        mqttUrl={null}
        warnings={runtime.warnings}
      />
    )

    await runUntilSignal(async () => {
      app.unmount()
      console.log("\nShutting down...")
      await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
      await stopQuietly(() => server?.stop() ?? Promise.resolve())
      await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
    })
  } catch (error) {
    app.unmount()
    await stopQuietly(() => customAppServer?.stop() ?? Promise.resolve())
    await stopQuietly(() => server?.stop() ?? Promise.resolve())
    await stopQuietly(() => runtime?.stop() ?? Promise.resolve())
    const message = error instanceof Error ? error.message : String(error)
    await renderStatic(<ErrorView message={message} />)
    process.exit(1)
  }
}
