import { mkdirSync } from "node:fs"
import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { DuckLakeStorage } from "@sixb/ducklake"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { SmolvmSandboxFactory } from "@sixb/sandboxes-smolvm"
import { SqliteStorage } from "@sixb/sqlite"

const localLakePath = ".sixb/lake"
mkdirSync(localLakePath, { recursive: true })

export const sixb = createSixb({
  id: "northline",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new DuckLakeStorage({
    catalog: { type: "duckdb", path: `${localLakePath}/catalog.ducklake` },
    dataPath: `${localLakePath}/data`,
  }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
  sandboxes:
    process.env.SIXB_SANDBOX_PROVIDER === "smolvm"
      ? new SmolvmSandboxFactory({ image: process.env.SIXB_AGENT_IMAGE, timeout: 30_000 })
      : new LocalSandboxFactory({ timeout: 30_000 }),
  onError(error, context) {
    let failure: string
    if (context.type === "run.failed") {
      failure = `${context.runKind} run '${context.run.runId}' failed with ${context.failure.code}`
    } else if (context.type === "action.phase.failed") {
      failure = `action '${context.actionId}' phase '${context.phase}' failed with ${context.failure.code}`
    } else if (context.type === "event.delivery.failed") {
      failure = `event delivery failed with ${context.failure.code} after ${context.attempts} attempt(s)`
    } else {
      failure = `${context.source} rule evaluation failed with ${context.failure.code}`
    }
    console.error(`[Northline] ${failure} (${context.notificationId}):`, error)
  },
})
