import { describe, expect, test } from "bun:test"
import {
  change,
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
  type SixbErrorContext,
  type SixbErrorHandler,
  SixbHost,
  type SyncDefinition,
} from "@sixb/core"
import { LOGS_STREAM } from "@sixb/core/internal/logging"
import type { BeginDatasetWriteInput, LakeWriteSession } from "@sixb/core/lake-storage"
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

class ReusingVersionLakeStorage extends InMemoryLakeStorage {
  private reuseNext = false

  reuseNextCommittedVersion(): void {
    this.reuseNext = true
  }

  override async beginWrite(input: BeginDatasetWriteInput): Promise<LakeWriteSession> {
    const write = await super.beginWrite(input)
    if (!this.reuseNext) return write
    this.reuseNext = false

    return {
      writeRows: (rows) => write.writeRows(rows),
      commit: async () => {
        await write.abort()
        const latest = await this.getLatestVersion(input.dataset.id)
        if (!latest) throw new Error("Expected a committed version to reuse.")
        return { ...latest, outcome: "unchanged" }
      },
      abort: () => write.abort(),
    }
  }
}

function createSixbForSync(
  sync: SyncDefinition,
  lakeStorage: InMemoryLakeStorage = new InMemoryLakeStorage(),
  onError?: SixbErrorHandler
) {
  const storage = new InMemoryStorage()

  return new SixbHost({
    id: "sync-worker-tests",
    ontology: [Room],
    connectors: [erpDb],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage,
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    datasets: [sync.target.dataset],
    syncs: [sync],
    onError,
  })
}

describe("SyncWorker", () => {
  test("processes queued sync jobs end-to-end", async () => {
    const rawOrdersDataset = makeDataset("raw.erp.orders")
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [{ orderId: "ord_1" }, { orderId: "ord_2" }])
      .intoDataset(rawOrdersDataset)
    const sixb = createSixbForSync(sync)
    const worker = new SyncWorker(sixb)

    await sixb.queues.syncRuns.enqueue({
      projectId: sixb.id,
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
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-1" }),
      (value) => value?.status === "succeeded"
    )

    expect(run?.rowsRead).toBe(2)
    expect(run?.output?.datasetId).toBe("raw.erp.orders")

    const claimed = await sixb.queues.syncRuns.claim({
      projectId: sixb.id,
      workerId: "observer",
    })

    expect(claimed).toHaveLength(0)

    await worker.stop()
  })

  test("reports once when execution transitions the run to failed", async () => {
    const reports: { error: Error; context: SixbErrorContext }[] = []
    const originalError = new Error("sync source failed")
    const dataset = makeDataset("raw.erp.failed-orders")
    const sync = defineSync("sync-failed-orders")
      .from(erpDb)
      .read(() => {
        throw originalError
      })
      .intoDataset(dataset)
    const sixb = createSixbForSync(sync, undefined, (error, context) => {
      reports.push({ error, context })
    })
    const worker = new SyncWorker(sixb)

    await sixb.queues.syncRuns.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: { syncId: sync.id, runId: "run-failed" },
        },
      ],
    })

    await worker.start()
    try {
      const run = await waitFor(
        () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-failed" }),
        (value) => value?.status === "failed"
      )
      await waitFor(
        async () => reports.length,
        (count) => count === 1
      )

      expect(run?.error).toMatchObject({
        code: "sync.execution_failed",
        details: {
          syncId: sync.id,
          runId: "run-failed",
          datasetId: dataset.id,
        },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.error).toBe(originalError)
      expect(reports[0]?.context).toEqual({
        type: "run.failed",
        notificationId: `project:${sixb.id}:run:sync:run-failed:failed:${run!.error!.at}`,
        projectId: sixb.id,
        occurredAt: run!.error!.at,
        attempt: 1,
        runKind: "sync",
        run: {
          runId: "run-failed",
          syncId: sync.id,
        },
        failure: run!.error!,
      })

      const claimed = await sixb.queues.syncRuns.claim({
        projectId: sixb.id,
        workerId: "observer",
      })
      expect(claimed).toHaveLength(0)
    } finally {
      await worker.stop()
    }

    const failedRun = await sixb.storage.syncRuns!.getById({
      projectId: sixb.id,
      id: "run-failed",
    })
    if (!failedRun) throw new Error("Expected the failed sync run to be persisted.")
    const events = await sixb.events.read({ types: ["sync.run.finished"] })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({
      syncId: failedRun.syncId,
      runId: failedRun.id,
      status: "failed",
      datasetId: failedRun.datasetId,
      error: failedRun.error,
    })
  })

  test("streams a run-scoped log line to the broker", async () => {
    const dataset = makeDataset("raw.erp.orders")
    const sync = defineSync("sync-logged")
      .from(erpDb)
      .read((_client, context) => {
        context.logger.info("Reading orders", { source: "erp" })
        return [{ orderId: "ord_1" }]
      })
      .intoDataset(dataset)
    const sixb = createSixbForSync(sync)
    const worker = new SyncWorker(sixb)

    await sixb.queues.syncRuns.enqueue({
      projectId: sixb.id,
      jobs: [{ type: "sync.run.requested", payload: { syncId: "sync-logged", runId: "run-log" } }],
    })

    await worker.start()
    await waitFor(
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-log" }),
      (value) => value?.status === "succeeded"
    )
    await worker.stop()

    const { records } = await sixb.broker.read({
      projectId: sixb.id,
      streamId: LOGS_STREAM.id,
      names: ["sync.info"],
    })
    const line = records.find(
      (record) => (record.payload as { message?: string }).message === "Reading orders"
    )
    expect(line?.key).toBe("sync:run-log")
    const payload = line?.payload as {
      level: string
      fields?: { source?: string }
      context?: { run?: { kind?: string; id?: string } }
    }
    expect(payload.level).toBe("info")
    expect(payload.fields?.source).toBe("erp")
    expect(payload.context?.run).toEqual({ kind: "sync", id: "run-log" })
  })

  test("uses a fallback run id when the queue payload does not provide one", async () => {
    const rawOrdersDataset = makeDataset("raw.erp.orders")
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersDataset)
    const sixb = createSixbForSync(sync)
    const worker = new SyncWorker(sixb)

    const [queued] = await sixb.queues.syncRuns.enqueue({
      projectId: sixb.id,
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
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: fallbackRunId }),
      (value) => value?.status === "succeeded"
    )

    expect(run?.id).toBe(fallbackRunId)

    await worker.stop()
  })

  test("retries an aborted in-flight sync without reporting it", async () => {
    let reportCount = 0
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
    const sixb = createSixbForSync(sync, undefined, () => {
      reportCount += 1
    })
    const worker = new SyncWorker(sixb)

    const [queued] = await sixb.queues.syncRuns.enqueue({
      projectId: sixb.id,
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
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-retry" }),
      (value) => value?.status === "running"
    )

    await worker.stop()

    const cancelledRun = await waitFor(
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-retry" }),
      (value) => value?.status === "cancelled"
    )

    expect(cancelledRun?.status).toBe("cancelled")

    const [retried] = await sixb.queues.syncRuns.claim({
      projectId: sixb.id,
      workerId: "observer",
    })

    expect(retried?.job.id).toBe(queued?.id)
    expect(retried?.job.attempt).toBe(2)
    if (!cancelledRun) throw new Error("Expected the cancelled sync run to be persisted.")
    const events = await sixb.events.read({ types: ["sync.run.finished"] })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({
      syncId: cancelledRun.syncId,
      runId: cancelledRun.id,
      status: "cancelled",
      datasetId: cancelledRun.datasetId,
      error: cancelledRun.error,
    })
    expect(reportCount).toBe(0)
  })

  test("survives a transient claim error and keeps polling", async () => {
    const rawOrdersDataset = makeDataset("raw.erp.orders")
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [{ orderId: "ord_1" }])
      .intoDataset(rawOrdersDataset)
    const sixb = createSixbForSync(sync)

    let claimCallCount = 0
    const originalClaim = sixb.queues.syncRuns.claim.bind(sixb.queues.syncRuns)
    sixb.queues.syncRuns.claim = async (params) => {
      claimCallCount++
      if (claimCallCount === 1) {
        throw new Error("Transient network failure")
      }
      return originalClaim(params)
    }

    await sixb.queues.syncRuns.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: { syncId: "sync-orders", runId: "run-after-error" },
        },
      ],
    })

    const worker = new SyncWorker(sixb)
    await worker.start()

    const run = await waitFor(
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-after-error" }),
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
    const sixb = createSixbForSync(sync)
    const worker = new SyncWorker(sixb)

    await sixb.queues.syncRuns.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: { syncId: "sync-orders", runId: "run-emit" },
        },
      ],
    })

    await worker.start()

    const run = await waitFor(
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-emit" }),
      (value) => value?.status === "succeeded"
    )

    // Allow best-effort emission to settle
    await Bun.sleep(50)
    await worker.stop()

    const events = await sixb.events.read({
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
    if (!run) throw new Error("Expected the succeeded sync run to be persisted.")
    expect(payload).toEqual({
      syncId: run.syncId,
      runId: run.id,
      status: "succeeded",
      datasetId: run.datasetId,
      versionId: run.output?.versionId,
    })
    expect(payload.versionId).toBe(datasetPayload.versionId)
  })

  test("emits a dataset event for a created merge but not for a later no-op", async () => {
    const dataset = defineDataset("raw.erp.keyed-orders", {
      schema: [col("orderId", "string"), col("status", "string")],
      primaryKey: "orderId",
    })
    const sync = defineSync("sync-keyed-orders", { mode: "merge" })
      .checkpoint<{ cursor: string }>()
      .from(erpDb)
      .read((_client, context) => {
        context.setCheckpoint({ cursor: context.checkpoint ? "cursor-2" : "cursor-1" })
        return [change.upsert({ orderId: "ord_1", status: "open" })]
      })
      .intoDataset(dataset)
    const sixb = createSixbForSync(sync)
    const worker = new SyncWorker(sixb)

    await sixb.queues.syncRuns.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: { syncId: sync.id, runId: "run-merge-created" },
        },
      ],
    })
    await worker.start()
    const createdRun = await waitFor(
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-merge-created" }),
      (run) => run?.status === "succeeded"
    )

    await sixb.queues.syncRuns.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: { syncId: sync.id, runId: "run-merge-noop" },
        },
      ],
    })
    const noOpRun = await waitFor(
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-merge-noop" }),
      (run) => run?.status === "succeeded"
    )
    await Bun.sleep(50)
    await worker.stop()

    expect(createdRun?.checkpoint).toEqual({ cursor: "cursor-1" })
    expect(noOpRun?.checkpoint).toEqual({ cursor: "cursor-2" })
    expect(noOpRun?.output?.versionId).toBe(createdRun?.output?.versionId)

    const events = await sixb.events.read({
      types: ["sync.run.started", "dataset.version.committed", "sync.run.finished"],
    })
    expect(events.map((event) => event.type)).toEqual([
      "sync.run.started",
      "dataset.version.committed",
      "sync.run.finished",
      "sync.run.started",
      "sync.run.finished",
    ])
  })

  test("does not emit a dataset event when storage reuses an existing version", async () => {
    const dataset = defineDataset("raw.erp.orders", { schema: [col("orderId", "string")] })
    const sync = defineSync("sync-orders", { mode: "append" })
      .from(erpDb)
      .read(() => [])
      .intoDataset(dataset)
    const lakeStorage = new ReusingVersionLakeStorage()
    await lakeStorage.createDataset(dataset)
    const seed = await lakeStorage.beginWrite({ dataset, mode: "snapshot" })
    await seed.writeRows([{ orderId: "ord_1" }])
    const previous = await seed.commit()
    lakeStorage.reuseNextCommittedVersion()

    const sixb = createSixbForSync(sync, lakeStorage)
    const worker = new SyncWorker(sixb)
    await sixb.queues.syncRuns.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: { syncId: sync.id, runId: "run-no-op" },
        },
      ],
    })

    await worker.start()
    await waitFor(
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-no-op" }),
      (run) => run?.status === "succeeded"
    )
    await Bun.sleep(50)
    await worker.stop()

    const events = await sixb.events.read({
      types: ["sync.run.started", "dataset.version.committed", "sync.run.finished"],
    })
    expect(events.map((event) => event.type)).toEqual(["sync.run.started", "sync.run.finished"])
    expect(events[1]?.payload).toMatchObject({
      syncId: sync.id,
      runId: "run-no-op",
      status: "succeeded",
      versionId: previous.versionId,
    })
  })

  test("finishes a first empty append without emitting a dataset version", async () => {
    const dataset = defineDataset("raw.erp.orders", { schema: [col("orderId", "string")] })
    const sync = defineSync("sync-orders", { mode: "append" })
      .checkpoint<{ cursor: string }>()
      .from(erpDb)
      .read((_client, context) => {
        context.setCheckpoint({ cursor: "cursor-1" })
        return []
      })
      .intoDataset(dataset)
    const sixb = createSixbForSync(sync)
    const worker = new SyncWorker(sixb)

    await sixb.queues.syncRuns.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: { syncId: sync.id, runId: "run-first-empty" },
        },
      ],
    })

    await worker.start()
    const run = await waitFor(
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-first-empty" }),
      (value) => value?.status === "succeeded"
    )
    await Bun.sleep(50)
    await worker.stop()

    expect(run?.output).toBeUndefined()
    expect(run?.checkpoint).toEqual({ cursor: "cursor-1" })
    const events = await sixb.events.read({
      types: ["sync.run.started", "dataset.version.committed", "sync.run.finished"],
    })
    expect(events.map((event) => event.type)).toEqual(["sync.run.started", "sync.run.finished"])
    expect(events[1]?.payload).toEqual({
      syncId: sync.id,
      runId: "run-first-empty",
      status: "succeeded",
      datasetId: dataset.id,
    })
  })

  test("finishes a first empty snapshot without emitting a dataset version", async () => {
    const dataset = defineDataset("raw.erp.empty-orders", {
      schema: [col("orderId", "string")],
    })
    const sync = defineSync("sync-empty-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(dataset)
    const sixb = createSixbForSync(sync)
    const worker = new SyncWorker(sixb)

    await sixb.queues.syncRuns.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: { syncId: sync.id, runId: "run-first-empty-snapshot" },
        },
      ],
    })

    await worker.start()
    const run = await waitFor(
      () =>
        sixb.storage.syncRuns!.getById({
          projectId: sixb.id,
          id: "run-first-empty-snapshot",
        }),
      (value) => value?.status === "succeeded"
    )
    await Bun.sleep(50)
    await worker.stop()

    expect(run?.output).toBeUndefined()
    const events = await sixb.events.read({
      types: ["sync.run.started", "dataset.version.committed", "sync.run.finished"],
    })
    expect(events.map((event) => event.type)).toEqual(["sync.run.started", "sync.run.finished"])
    expect(events[1]?.payload).toEqual({
      syncId: sync.id,
      runId: "run-first-empty-snapshot",
      status: "succeeded",
      datasetId: dataset.id,
    })
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
    const sixb = createSixbForSync(sync)

    sixb.queues.syncRuns.retry = async () => {
      throw new Error("Lease already expired")
    }

    await sixb.queues.syncRuns.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: { syncId: "sync-orders", runId: "run-expired-lease" },
        },
      ],
    })

    const worker = new SyncWorker(sixb)
    await worker.start()

    await waitFor(
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-expired-lease" }),
      (value) => value?.status === "running"
    )

    await worker.stop()
  })
})
