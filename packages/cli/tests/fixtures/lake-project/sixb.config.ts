import { appendFileSync } from "node:fs"
import {
  col,
  type DatasetDefinition,
  defineDataset,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  Sixb,
} from "@sixb/core"
import { SixbError } from "@sixb/core/errors"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const things = defineDataset("raw.things", {
  schema: [col("id", "string", { nullable: true })],
})

function logFixtureEvent(entry: Record<string, unknown>): void {
  const logPath = process.env.SIXB_CLI_TEST_LOG
  if (!logPath) return
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8")
}

// Mirrors the real lake drift failure without needing a Postgres-backed catalog:
// the command path is what these tests exercise, not the diff algorithm itself.
class FixtureLakeStorage extends InMemoryLakeStorage {
  override async assertDatasetDefinitionsCompatible(
    definitions: readonly DatasetDefinition[]
  ): Promise<void> {
    if (process.env.SIXB_CLI_TEST_LAKE_DRIFT === "1") {
      const datasetId = definitions[0]?.id ?? "unknown"
      throw new SixbError(
        "storage.lake_failed",
        `[SixbLake] Lake dataset definition check failed for 1 dataset(s).\n- ${datasetId}: dataset '${datasetId}' has drifted from the lake catalog`
      )
    }
    return super.assertDatasetDefinitionsCompatible(definitions)
  }

  async close(): Promise<void> {
    logFixtureEvent({ type: "lake-storage:close" })
  }
}

class MaintenanceLakeStorage extends FixtureLakeStorage {
  async runMaintenance(options?: {
    readonly dryRun?: boolean
    readonly expireOlderThan?: string
    readonly deleteOlderThan?: string
  }) {
    logFixtureEvent({
      type: "lake:maintenance",
      dryRun: options?.dryRun ?? false,
      expireOlderThan: options?.expireOlderThan,
      deleteOlderThan: options?.deleteOlderThan,
    })

    return {
      dryRun: options?.dryRun ?? false,
      expireOlderThan: options?.expireOlderThan ?? "7 days",
      deleteOlderThan: options?.deleteOlderThan ?? options?.expireOlderThan ?? "7 days",
      snapshots: 2,
      oldFiles: 3,
      orphanedFiles: 4,
    }
  }
}

function createLakeStorage(): FixtureLakeStorage {
  if (process.env.SIXB_CLI_TEST_LAKE_NO_MAINTENANCE === "1") {
    return new FixtureLakeStorage()
  }

  return new MaintenanceLakeStorage()
}

export const sixb = new Sixb({
  id: "cli-lake-project",
  ontology: [Room],
  broker: new InMemoryBroker(),
  storage: new InMemoryStorage(),
  lakeStorage: createLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
  datasets: [things],
})
