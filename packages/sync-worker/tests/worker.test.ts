import { describe, expect, test } from "bun:test"
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
  Pario,
  prop,
  type SyncDefinition,
} from "@pario/core"
import { SyncWorker } from "../src"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const erpDb = defineConnector("erpDb", {
  type: "sql",
  connect() {
    return {}
  },
})

function makeDataset(id: string) {
  return defineDataset(id, {
    schema: [col("orderId", "string"), col("customerName", "string", { nullable: true })],
  })
}

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2_000
): Promise<T> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn()
    if (predicate(value)) {
      return value
    }

    await Bun.sleep(20)
  }

  throw new Error("Timed out waiting for condition.")
}

function createParioForSync(sync: SyncDefinition) {
  const storage = new InMemoryStorage()

  return new Pario({
    id: "sync-worker-tests",
    ontology: [Room],
    connectors: [erpDb],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    datasets: [sync.target.dataset],
    syncs: [sync],
  })
}

describe("SyncWorker", () => {
  test("processes queued sync jobs end-to-end", async () => {
    const rawOrdersDataset = makeDataset("raw.erp.orders")
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [{ orderId: "ord_1" }, { orderId: "ord_2" }])
      .intoDataset(rawOrdersDataset)
    const pario = createParioForSync(sync)
    const worker = new SyncWorker(pario)

    await pario.queues.syncRuns.enqueue({
      projectId: pario.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: {
            syncId: "sync-orders",
            runId: "run-1",
          },
        },
      ],
    })

    await worker.start()

    const run = await waitFor(
      () => pario.storage.syncRuns!.getById({ projectId: pario.id, id: "run-1" }),
      (value) => value?.status === "succeeded"
    )

    expect(run?.rowsRead).toBe(2)
    expect(run?.output?.datasetId).toBe("raw.erp.orders")

    const claimed = await pario.queues.syncRuns.claim({
      projectId: pario.id,
      workerId: "observer",
    })

    expect(claimed).toHaveLength(0)

    await worker.stop()
  })

  test("uses a fallback run id when the queue payload does not provide one", async () => {
    const rawOrdersDataset = makeDataset("raw.erp.orders")
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersDataset)
    const pario = createParioForSync(sync)
    const worker = new SyncWorker(pario)

    const [queued] = await pario.queues.syncRuns.enqueue({
      projectId: pario.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: {
            syncId: "sync-orders",
          },
        },
      ],
    })

    await worker.start()

    const fallbackRunId = `${queued!.id}:attempt:1`
    const run = await waitFor(
      () => pario.storage.syncRuns!.getById({ projectId: pario.id, id: fallbackRunId }),
      (value) => value?.status === "succeeded"
    )

    expect(run?.id).toBe(fallbackRunId)

    await worker.stop()
  })

  test("retries the queue job when shutdown aborts an in-flight sync", async () => {
    const rawOrdersDataset = makeDataset("raw.erp.orders")
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(async (_client, context) => {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted")
              error.name = "AbortError"
              reject(error)
            },
            { once: true }
          )
        })
        return []
      })
      .intoDataset(rawOrdersDataset)
    const pario = createParioForSync(sync)
    const worker = new SyncWorker(pario)

    const [queued] = await pario.queues.syncRuns.enqueue({
      projectId: pario.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: {
            syncId: "sync-orders",
            runId: "run-retry",
          },
        },
      ],
    })

    await worker.start()

    await waitFor(
      () => pario.storage.syncRuns!.getById({ projectId: pario.id, id: "run-retry" }),
      (value) => value?.status === "running"
    )

    await worker.stop()

    const cancelledRun = await waitFor(
      () => pario.storage.syncRuns!.getById({ projectId: pario.id, id: "run-retry" }),
      (value) => value?.status === "cancelled"
    )

    expect(cancelledRun?.status).toBe("cancelled")

    const [retried] = await pario.queues.syncRuns.claim({
      projectId: pario.id,
      workerId: "observer",
    })

    expect(retried?.job.id).toBe(queued?.id)
    expect(retried?.job.attempt).toBe(2)
  })

  test("survives a transient claim error and keeps polling", async () => {
    const rawOrdersDataset = makeDataset("raw.erp.orders")
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [{ orderId: "ord_1" }])
      .intoDataset(rawOrdersDataset)
    const pario = createParioForSync(sync)

    let claimCallCount = 0
    const originalClaim = pario.queues.syncRuns.claim.bind(pario.queues.syncRuns)
    pario.queues.syncRuns.claim = async (params) => {
      claimCallCount++
      if (claimCallCount === 1) {
        throw new Error("Transient network failure")
      }
      return originalClaim(params)
    }

    await pario.queues.syncRuns.enqueue({
      projectId: pario.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: { syncId: "sync-orders", runId: "run-after-error" },
        },
      ],
    })

    const worker = new SyncWorker(pario)
    await worker.start()

    const run = await waitFor(
      () => pario.storage.syncRuns!.getById({ projectId: pario.id, id: "run-after-error" }),
      (value) => value?.status === "succeeded"
    )

    expect(run?.status).toBe("succeeded")
    expect(claimCallCount).toBeGreaterThanOrEqual(2)

    await worker.stop()
  })

  test("emits sync run lifecycle events after a succeeded sync run", async () => {
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [{ orderId: "ord_1" }])
      .intoDataset(defineDataset("raw.erp.orders", { schema: [col("orderId", "string")] }))
    const pario = createParioForSync(sync)
    const worker = new SyncWorker(pario)

    await pario.queues.syncRuns.enqueue({
      projectId: pario.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: { syncId: "sync-orders", runId: "run-emit" },
        },
      ],
    })

    await worker.start()

    await waitFor(
      () => pario.storage.syncRuns!.getById({ projectId: pario.id, id: "run-emit" }),
      (value) => value?.status === "succeeded"
    )

    // Allow best-effort emission to settle
    await Bun.sleep(50)
    await worker.stop()

    const events = await pario.events.read({
      types: ["sync.run.started", "dataset.version.committed", "sync.run.finished"],
    })

    expect(events).toHaveLength(3)
    expect(events.map((event) => event.type)).toEqual([
      "sync.run.started",
      "dataset.version.committed",
      "sync.run.finished",
    ])

    expect(events[0]!.payload).toMatchObject({
      syncId: "sync-orders",
      runId: "run-emit",
    })
    expect((events[0]!.payload as { startedAt?: string }).startedAt).toBeDefined()

    const datasetPayload = events[1]!.payload as {
      datasetId: string
      versionId: string
      producer: { kind: string; id?: string; runId?: string }
    }
    expect(datasetPayload.datasetId).toBe("raw.erp.orders")
    expect(datasetPayload.versionId).toBeDefined()
    expect(datasetPayload.producer).toEqual({
      kind: "sync",
      id: "sync-orders",
      runId: "run-emit",
    })

    const payload = events[2]!.payload as {
      syncId: string
      runId: string
      status: string
      datasetId?: string
      versionId?: string
    }
    expect(payload.syncId).toBe("sync-orders")
    expect(payload.runId).toBe("run-emit")
    expect(payload.status).toBe("succeeded")
    expect(payload.datasetId).toBe("raw.erp.orders")
    expect(payload.versionId).toBe(datasetPayload.versionId)
  })

  test("does not crash when retry fails on shutdown", async () => {
    const rawOrdersDataset = makeDataset("raw.erp.orders")
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(async (_client, context) => {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted")
              error.name = "AbortError"
              reject(error)
            },
            { once: true }
          )
        })
        return []
      })
      .intoDataset(rawOrdersDataset)
    const pario = createParioForSync(sync)

    pario.queues.syncRuns.retry = async () => {
      throw new Error("Lease already expired")
    }

    await pario.queues.syncRuns.enqueue({
      projectId: pario.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: { syncId: "sync-orders", runId: "run-expired-lease" },
        },
      ],
    })

    const worker = new SyncWorker(pario)
    await worker.start()

    await waitFor(
      () => pario.storage.syncRuns!.getById({ projectId: pario.id, id: "run-expired-lease" }),
      (value) => value?.status === "running"
    )

    await worker.stop()
  })
})
