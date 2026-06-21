import { appendFileSync } from "node:fs"
import {
  col,
  defineConnector,
  defineDataset,
  defineObjectType,
  defineSync,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  type Queues,
  Sixb,
  type Storage,
} from "@sixb/core"

// A registered sync makes the sync worker run for real (it does not idle), but
// the storage below omits `syncRuns`, so the worker throws during construction.
// This exercises the "startup fails after loading the runtime" provider-cleanup
// path without relying on the (now removed) no-definitions crash.

const Transaction = defineObjectType({
  id: "Transaction",
  name: "Transaction",
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

const ordersSync = defineSync("sync-orders")
  .from(erpDb)
  .read(() => [])
  .intoDataset(rawOrders)

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
  get actions() {
    return this.inner.actions
  }

  async close(): Promise<void> {
    logFixtureEvent({ type: "queues:close" })
  }
}

// Drop the sync-run store so the sync worker fails its storage requirement.
const storage = Object.assign(new InMemoryStorage(), { syncRuns: undefined }) as unknown as Storage

export const sixb = new Sixb({
  id: "cli-worker-missing-run-storage",
  ontology: [Transaction],
  connectors: [erpDb],
  broker: new InMemoryBroker(),
  storage,
  lakeStorage: new TrackingLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new SharedQueues(),
  datasets: [rawOrders],
  syncs: [ordersSync],
})
