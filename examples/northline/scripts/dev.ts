import { resolve } from "node:path"
import { initializeDemoSources } from "../lib/sources/source-state"
import { apiBaseUrl, apiRequest, isRecord, waitUntil } from "./api"
import { synchronizeDemo } from "./sync-demo"

export function createRuntimeCommand(args: readonly string[]): string[] {
  return [
    process.execPath,
    resolve(import.meta.dir, "../../../packages/cli/src/index.tsx"),
    "dev",
    ...args,
  ]
}

async function main(): Promise<void> {
  const initialized = await initializeDemoSources()
  if (initialized) console.log("[Northline] Initialized deterministic demo sources.")

  const child = Bun.spawn(createRuntimeCommand(process.argv.slice(2)), {
    cwd: resolve(import.meta.dir, ".."),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })

  const stop = () => child.kill("SIGTERM")
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)

  try {
    await waitUntil(
      "the Sixb API",
      async () => {
        try {
          const response = await fetch(`${apiBaseUrl()}/syncs`)
          return response.ok
        } catch {
          return false
        }
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
      console.log("[Northline] Northline Operations is ready. Open http://localhost:3001")
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
