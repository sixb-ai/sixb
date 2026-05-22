import { appendFileSync } from "node:fs"
import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  Pario,
  prop,
  type StorageMigrator,
} from "@pario/core"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
})

interface FixtureParioOptions {
  projectId: string
  logStorageMigrate?: boolean
}

function logFixtureEvent(entry: Record<string, unknown>): void {
  const logPath = process.env.PARIO_CLI_TEST_LOG
  if (!logPath) return
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8")
}

function createFixtureStorage(logStorageMigrate: boolean) {
  if (!logStorageMigrate) {
    return new InMemoryStorage()
  }

  const migrator: StorageMigrator = {
    adapterId: "FixtureStorage",
    latestVersion: 1,
    async plan() {
      throw new Error("plan should not run")
    },
    async migrate() {
      logFixtureEvent({ type: "storage.migrate" })
      return {
        adapterId: "FixtureStorage",
        latestVersion: 1,
        status: "migrated",
        applied: ["001-fixture"],
        skipped: [],
      }
    },
  }

  return Object.assign(new InMemoryStorage(), { migrators: [migrator] })
}

export function createFixturePario(options: FixtureParioOptions) {
  return new Pario({
    id: options.projectId,
    ontology: [Room],
    broker: new InMemoryBroker(),
    storage: createFixtureStorage(options.logStorageMigrate ?? false),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
}
