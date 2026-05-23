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
  prop,
  type Queues,
  Sixb,
  type StorageMigrator,
} from "@sixb/core"

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
  const logPath = process.env.SIXB_CLI_TEST_LOG
  if (!logPath) return
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8")
}

class TrackingLakeStorage extends InMemoryLakeStorage {
  async close(): Promise<void> {
    logFixtureEvent({ type: "lake-storage:close" })
  }
}

// Wraps a queue so the first `claim` poll logs which worker type came online.
// Workers poll their queue immediately on start, so this reveals exactly which
// workers a `worker-group` invocation booted — without relying on Ink output.
function claimLoggingQueue<T extends object>(queue: T, workerType: string): T {
  let logged = false
  return new Proxy(queue, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop === "claim" && typeof value === "function") {
        return (...args: unknown[]) => {
          if (!logged) {
            logged = true
            logFixtureEvent({ type: "claim", workerType })
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

// Not an `InMemoryQueues` instance, so it passes the shared-queue guard while
// still backed by real in-memory queues for the workers to poll.
class SharedQueues implements Queues {
  private readonly inner = new InMemoryQueues()
  readonly syncRuns = claimLoggingQueue(this.inner.syncRuns, "sync")
  readonly pipelines = claimLoggingQueue(this.inner.pipelines, "pipeline")
  readonly projections = claimLoggingQueue(this.inner.projections, "projection")
  readonly workflows = claimLoggingQueue(this.inner.workflows, "workflow")

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
