import { appendFileSync } from "node:fs"
import {
  col,
  defineConnector,
  defineDataset,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineSync,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  Pario,
  prop,
  type Queues,
  type StorageMigrator,
} from "@pario/core"

const Order = defineObjectType({
  id: "Order",
  name: "Order",
  properties: [prop("id", "string", { required: true, primary: true })],
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

const canonicalOrders = defineDataset("canonical.orders", {
  schema: [col("id", "string", { nullable: true })],
})

const ordersSync = defineSync("sync-orders")
  .from(erpDb)
  .read(() => [])
  .intoDataset(rawOrders)

const normalizeStep = definePipelineStep("normalize-orders")
  .inputs({ rawOrders })
  .output(canonicalOrders)
  .run(async () => {})

const normalizePipeline = definePipeline("normalize-orders").then(normalizeStep)

const orderProjection = defineProjection("order-proj", Order)
  .fromDataset(rawOrders)
  .properties({ id: "orderId" })

function logFixtureEvent(entry: Record<string, unknown>): void {
  const logPath = process.env.PARIO_CLI_TEST_LOG
  if (!logPath) return
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8")
}

class TrackingLakeStorage extends InMemoryLakeStorage {
  async close(): Promise<void> {
    logFixtureEvent({ type: "lake-storage:close" })
  }
}

// Not an `InMemoryQueues` instance, so it passes the shared-queue guard while
// still backed by real in-memory queues for the workers to poll.
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

export const pario = new Pario({
  id: "cli-worker-group",
  ontology: [Order],
  connectors: [erpDb],
  broker: new InMemoryBroker(),
  storage: loggingStorage(),
  lakeStorage: new TrackingLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new SharedQueues(),
  datasets: [rawOrders, canonicalOrders],
  syncs: [ordersSync],
  pipelines: [normalizePipeline],
  projections: [orderProjection],
})
