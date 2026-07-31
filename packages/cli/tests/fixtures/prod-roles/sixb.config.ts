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
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  type Queues,
  type RuleDefinition,
  Sixb,
  type StorageMigrator,
} from "@sixb/core"
import { SharedBroker } from "../shared/sharedBroker"

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
// the lake catalog (guarding against a thundering-herd regression).
class TrackingLakeStorage extends InMemoryLakeStorage {
  override async assertDatasetDefinitionsCompatible(
    definitions: readonly DatasetDefinition[]
  ): Promise<void> {
    for (const definition of definitions) {
      logFixtureEvent({ type: "lake:assert", datasetId: definition.id })
    }
    return super.assertDatasetDefinitionsCompatible(definitions)
  }

  async close(): Promise<void> {
    logFixtureEvent({ type: "lake-storage:close" })
  }
}

class SharedQueues implements Queues {
  readonly scope = "shared" as const
  private readonly inner = new InMemoryQueues()

  health(): Promise<void> {
    return this.inner.health()
  }

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
  get actions() {
    return this.inner.actions
  }
  get agents() {
    return this.inner.agents
  }

  async close(): Promise<void> {
    logFixtureEvent({ type: "queues:close" })
  }
}

function loggingStorage() {
  const migrator: StorageMigrator = {
    adapterId: "FixtureStorage",
    latestVersion: 1,
    async status() {
      logFixtureEvent({ type: "storage:status" })
      return {
        adapterId: "FixtureStorage",
        latestVersion: 1,
        appliedVersion: 1,
        state: "current",
      }
    },
    // `migrate()` runs the DDL, through `ensure()`. It is logged so the e2e can assert
    // that a boot migrates exactly once and that every later probe adds none — the
    // read-only-probe rule, which used to be witnessed by a `plan()` that no longer
    // exists on the contract.
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

  // `close` is logged so the role tests can assert the shutdown ORDER, not just that
  // shutdown happened: storage must close after the broker has drained the outbox it
  // reads from, or the final publication loses rows.
  return Object.assign(new InMemoryStorage(), {
    migrators: [migrator],
    close() {
      logFixtureEvent({ type: "storage:close" })
    },
  })
}

export const sixb = new Sixb({
  id: "cli-prod-roles",
  // Explicit disabled auth lets `sixb api` boot in production mode for tests.
  auth: { id: "disabled", kind: "disabled", allowDisabledInProduction: true },
  ontology: [Transaction],
  connectors: [erpDb],
  broker: new SharedBroker(),
  storage: loggingStorage(),
  lakeStorage: new TrackingLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new SharedQueues(),
  datasets: [rawOrders],
  syncs: [ordersSync],
  schedules: [daily],
  rules: [postedRule],
})
