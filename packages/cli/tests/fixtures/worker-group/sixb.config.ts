import { appendFileSync } from "node:fs"
import {
  col,
  type DatasetDefinition,
  defineAgent,
  defineConnector,
  defineDataset,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineSync,
  InMemoryBlobStorage,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  type Queues,
  type SandboxFactory,
  SixbHost,
  type StorageMigrator,
} from "@sixb/core"
import { SharedBroker } from "../shared/sharedBroker"

const assistant = defineAgent("assistant", {
  name: "Assistant",
  model: {} as Parameters<typeof defineAgent>[1]["model"],
  instructions: "Assist the user.",
})

const sandboxes: SandboxFactory = {
  async create() {
    throw new Error("The worker-group fixture does not execute agent runs.")
  },
}

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
  // Logs every definition probe so the group's startup can be shown not to open the lake
  // catalog. Co-hosting pipeline and projection workers makes this the role most likely to
  // regress into a startup-time lake attach.
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
            const params = args[0] as { readonly limit?: unknown } | undefined
            logFixtureEvent({ type: "claim", workerType, limit: params?.limit })
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
  readonly scope = "shared" as const
  private readonly inner = new InMemoryQueues()

  health(): Promise<void> {
    return this.inner.health()
  }

  readonly syncRuns = claimLoggingQueue(this.inner.syncRuns, "sync")
  readonly pipelines = claimLoggingQueue(this.inner.pipelines, "pipeline")
  readonly projections = claimLoggingQueue(this.inner.projections, "projection")
  readonly workflows = claimLoggingQueue(this.inner.workflows, "workflow")
  readonly actions = claimLoggingQueue(this.inner.actions, "action")
  readonly agents = claimLoggingQueue(this.inner.agents, "agent")

  async close(): Promise<void> {
    logFixtureEvent({ type: "queues:close" })
  }
}

function loggingStorage() {
  const migrator: StorageMigrator = {
    adapterId: "FixtureStorage",
    latestVersion: 1,
    async status() {
      return {
        adapterId: "FixtureStorage",
        latestVersion: 1,
        appliedVersion: 1,
        state: "current" as const,
      }
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

export const sixb = new SixbHost({
  id: "cli-worker-group",
  ontology: [Order],
  connectors: [erpDb],
  broker: new SharedBroker(),
  storage: loggingStorage(),
  lakeStorage: new TrackingLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new SharedQueues(),
  datasets: [rawOrders, canonicalOrders],
  syncs: [ordersSync],
  pipelines: [normalizePipeline],
  projections: [orderProjection],
  agents: [assistant],
  sandboxes,
})
