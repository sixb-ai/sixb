import { resolve } from "node:path"
import { initializeDemoSources } from "../lib/sources/source-state"
import { apiBaseUrl, apiRequest, isRecord, waitUntil } from "./api"
import { synchronizeDemo } from "./sync-demo"

const northlineProjectId = "northline"

type NorthlineApiProbe =
  | { readonly status: "ready" }
  | { readonly status: "unavailable" }
  | { readonly status: "wrong-project"; readonly projectId: string }

export function createRuntimeCommand(args: readonly string[]): string[] {
  return [
    process.execPath,
    resolve(import.meta.dir, "../../../packages/cli/src/index.tsx"),
    "dev",
    ...args,
  ]
}

/**
 * Where `sixb dev` will listen, read from the same `--port` and `--api-port` flags it receives:
 * the app on `--port` (default 3000) and the API on `--api-port` (default one past the app).
 */
export function resolveDevPorts(args: readonly string[]): { appPort: number; apiPort: number } {
  const appPort = readPortFlag(args, "port") ?? 3000
  return { appPort, apiPort: readPortFlag(args, "api-port") ?? appPort + 1 }
}

function readPortFlag(args: readonly string[], name: string): number | undefined {
  const flag = `--${name}`
  let value: string | undefined
  for (const [index, arg] of args.entries()) {
    if (arg === flag) value = args[index + 1]
    else if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1)
  }
  if (value === undefined) return undefined

  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`[Northline] ${flag} must be a port number, received '${value}'.`)
  }
  return port
}

export async function probeNorthlineApi(
  baseUrl: string,
  request: (url: string) => Promise<Response> = fetch
): Promise<NorthlineApiProbe> {
  try {
    const response = await request(`${baseUrl}/project`)
    if (!response.ok) return { status: "unavailable" }

    const project: unknown = await response.json()
    if (!isRecord(project) || typeof project.id !== "string") {
      return { status: "unavailable" }
    }
    if (project.id !== northlineProjectId) {
      return { status: "wrong-project", projectId: project.id }
    }
    return { status: "ready" }
  } catch {
    return { status: "unavailable" }
  }
}

async function main(): Promise<void> {
  const initialized = await initializeDemoSources()
  if (initialized) console.log("[Northline] Initialized deterministic demo sources.")

  const args = process.argv.slice(2)
  const { appPort, apiPort } = resolveDevPorts(args)
  // The demo scripts below reach the API through SIXB_API_URL, so point them at this server.
  process.env.SIXB_API_URL ??= `http://localhost:${apiPort}/api`

  const child = Bun.spawn(createRuntimeCommand(args), {
    cwd: resolve(import.meta.dir, ".."),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })

  const stop = () => child.kill("SIGTERM")
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)

  let childExitCode: number | undefined
  void child.exited.then((exitCode) => {
    childExitCode = exitCode
  })

  try {
    const baseUrl = apiBaseUrl()
    await waitUntil(
      "the Northline Sixb API",
      async () => {
        if (childExitCode !== undefined) {
          throw new Error(
            `[Northline] Sixb dev exited with code ${childExitCode} before its API became ready. ` +
              "Review the startup error above; the configured ports may already be in use."
          )
        }

        const probe = await probeNorthlineApi(baseUrl)
        if (probe.status === "wrong-project") {
          throw new Error(
            `[Northline] Expected project '${northlineProjectId}' at ${baseUrl}, but found ` +
              `'${probe.projectId}'. Another Sixb dev server is using Northline's API port. ` +
              "Stop it before starting Northline."
          )
        }
        return probe.status === "ready"
      },
      90_000
    )

    const requiredObjects = [
      ["CustomerAccount", 5],
      ["ServiceCase", 5],
      ["Equipment", 10],
      ["Technician", 7],
      ["WorkOrder", 4],
      ["Quote", 3],
    ] as const
    const counts = await Promise.all(
      requiredObjects.map(async ([objectTypeId]) => {
        const current = await apiRequest(
          `/objects?objectTypeId=${encodeURIComponent(objectTypeId)}&limit=1`
        )
        return isRecord(current) && typeof current.total === "number" ? current.total : 0
      })
    )
    if (counts.some((count, index) => count < requiredObjects[index][1])) {
      console.log("[Northline] Populating Northline Operations through the Sixb data plane...")
      await synchronizeDemo()
      console.log(`[Northline] Northline Operations is ready. Open http://localhost:${appPort}`)
    }
  } catch (error) {
    child.kill("SIGTERM")
    throw error
  }

  const exitCode = await child.exited
  process.exitCode = exitCode
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
