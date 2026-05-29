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
  Pario,
  prop,
} from "@pario/core"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const things = defineDataset("raw.things", {
  schema: [col("id", "string", { nullable: true })],
})

function logFixtureEvent(entry: Record<string, unknown>): void {
  const logPath = process.env.PARIO_CLI_TEST_LOG
  if (!logPath) return
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8")
}

// Mirrors the real lake drift failure without needing a Postgres-backed catalog:
// the command path is what these tests exercise, not the diff algorithm itself.
class FixtureLakeStorage extends InMemoryLakeStorage {
  override async assertDatasetDefinitionCompatible(definition: DatasetDefinition): Promise<void> {
    if (process.env.PARIO_CLI_TEST_LAKE_DRIFT === "1") {
      throw new Error(`dataset '${definition.id}' has drifted from the lake catalog`)
    }
    return super.assertDatasetDefinitionCompatible(definition)
  }

  async close(): Promise<void> {
    logFixtureEvent({ type: "lake-storage:close" })
  }
}

export const pario = new Pario({
  id: "cli-lake-project",
  ontology: [Room],
  broker: new InMemoryBroker(),
  storage: new InMemoryStorage(),
  lakeStorage: new FixtureLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
  datasets: [things],
})
