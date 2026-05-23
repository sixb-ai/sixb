import { appendFileSync } from "node:fs"
import {
  col,
  type DatasetDefinition,
  defineConnector,
  defineDataset,
  defineObjectType,
  defineSchedule,
  defineSync,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  type Queues,
  type RuleDefinition,
  Sixb,
  type StorageMigrator,
} from "@sixb/core"

const Transaction = defineObjectType({
  id: "Transaction",
  name: "Transaction",
  properties: [prop("id", "string", { required: true, primary: true }), prop("status", "string")],
})

const erpDb = defineConnector("erpDb", {
  type: "sql",
  connect() {
    return {}
  },
})

const rawOrders = defineDataset("raw.erp.orders", {
  schema: [col("orderId", "string", { nullable: true })],
})

const ordersSync = defineSync("sync-orders")
  .from(erpDb)
  .read(() => [])
  .intoDataset(rawOrders)

const daily = defineSchedule("prod-roles-daily").cron("0 2 * * *")

const postedRule: RuleDefinition = {
  kind: "rule",
  id: "transaction.posted",
  subject: { kind: "object", objectTypeId: "Transaction" },
  predicate: { kind: "property", propertyId: "status", op: "eq", value: "posted" },
}

function logFixtureEvent(entry: Record<string, unknown>): void {
  const logPath = process.env.SIXB_CLI_TEST_LOG
  if (!logPath) return
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8")
}

// Logs every lake definition probe so tests can assert role startup never opens
// the lake catalog (the thundering-herd regression this slice removes).
class TrackingLakeStorage extends InMemoryLakeStorage {
  override async assertDatasetDefinitionCompatible(definition: DatasetDefinition): Promise<void> {
    logFixtureEvent({ type: "lake:assert", datasetId: definition.id })
    return super.assertDatasetDefinitionCompatible(definition)
  }

  async close(): Promise<void> {
    logFixtureEvent({ type: "lake-storage:close" })
  }
}

// Not an `InMemoryQueues` instance and without an in-memory `provider` tag, so it
// passes the `sixb worker` shared-queue guard while still backed by real queues.
class SharedQueues implements Queues {
  private readonly inner = new InMemoryQueues()

  get syncRuns() {
    return this.inner.syncRuns
  }
  get pipelines() {
    return this.inner.pipelines
  }
  get projections() {
    return this.inner.projections
  }
  get workflows() {
    return this.inner.workflows
  }

  async close(): Promise<void> {
    logFixtureEvent({ type: "queues:close" })
  }
}

function loggingStorage() {
  const migrator: StorageMigrator = {
    adapterId: "FixtureStorage",
    latestVersion: 1,
    async plan() {
      throw new Error("plan should not run")
    },
    async migrate() {
      logFixtureEvent({ type: "storage:migrate" })
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

export const sixb = new Sixb({
  id: "cli-prod-roles",
  // Explicit disabled auth lets `sixb api` boot in production mode for tests.
  auth: { id: "disabled", kind: "disabled", allowDisabledInProduction: true },
  ontology: [Transaction],
  connectors: [erpDb],
  broker: new InMemoryBroker(),
  storage: loggingStorage(),
  lakeStorage: new TrackingLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new SharedQueues(),
  datasets: [rawOrders],
  syncs: [ordersSync],
  schedules: [daily],
  rules: [postedRule],
})
