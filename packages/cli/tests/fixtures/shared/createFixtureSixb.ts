import { appendFileSync } from "node:fs"
import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type ObjectQueryPreparationPlan,
  prop,
  SixbHost,
  type StorageMigrator,
} from "@sixb/core"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
})

interface FixtureSixbOptions {
  projectId: string
  logStorageMigrate?: boolean
  logStoragePrepare?: boolean
}

function logFixtureEvent(entry: Record<string, unknown>): void {
  const logPath = process.env.SIXB_CLI_TEST_LOG
  if (!logPath) return
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8")
}

function createFixtureStorage(logStorageMigrate: boolean, logStoragePrepare: boolean) {
  if (!logStorageMigrate) {
    return new InMemoryStorage()
  }

  const migrator: StorageMigrator = {
    adapterId: "FixtureStorage",
    latestVersion: 1,
    // `SIXB_CLI_TEST_MIGRATION_STATE` sets the state a test needs `sixb db migrate --check` to read.
    async status() {
      const state = process.env.SIXB_CLI_TEST_MIGRATION_STATE ?? "current"
      if (state === "current") {
        return { adapterId: "FixtureStorage", latestVersion: 1, appliedVersion: 1, state }
      }

      if (state !== "pending" && state !== "dirty") {
        throw new Error(`Unknown SIXB_CLI_TEST_MIGRATION_STATE: ${state}`)
      }
      return {
        adapterId: "FixtureStorage",
        latestVersion: 1,
        appliedVersion: 0,
        state,
        reason: `The fixture is ${state}.`,
      }
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

  return Object.assign(new InMemoryStorage(), {
    migrators: [migrator],
    ...(logStoragePrepare
      ? {
          prepareObjectQueries: async (plan: ObjectQueryPreparationPlan) => {
            logFixtureEvent({
              type: "storage.prepare",
              projectId: plan.projectId,
              objectTypes: plan.objectTypes.length,
            })
            return {
              status: "prepared" as const,
              objectTypes: plan.objectTypes.length,
              indexes: 0,
              warnings: [],
            }
          },
        }
      : {}),
  })
}

export function createFixtureSixb(options: FixtureSixbOptions) {
  return new SixbHost({
    id: options.projectId,
    ontology: [Room],
    broker: new InMemoryBroker(),
    storage: createFixtureStorage(
      options.logStorageMigrate ?? false,
      options.logStoragePrepare ?? false
    ),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
}
