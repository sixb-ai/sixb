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

function storedErpCheckpoint(cursor: string) {
  return {
    kind: "sync_checkpoint",
    version: 1,
    connectorId: erpDb.id,
    strategy: "single",
    value: { cursor },
  }
}

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

    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  throw new Error("Timed out waiting for condition.")
}

/** Waits for the run's `sync.run.finished` event, the last one a finished run emits. */
async function waitForFinishedEvents(sixb: SixbHost, count: number) {
  await waitFor(
    () => sixb.events.read({ types: ["sync.run.finished"] }),
    (events) => events.length === count
  )
  return sixb.events.read({
    types: ["sync.run.started", "dataset.version.committed", "sync.run.finished"],
  })
}

function createSixbForSync(sync: SyncDefinition, onError?: SixbErrorHandler) {
  const storage = new InMemoryStorage()

  return new SixbHost({
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
    onError,
  })
}

async function enqueueSyncRun(
  sixb: Pick<SixbHost, "id" | "storage" | "queues" | "definitions">,
  input: { readonly syncId: string; readonly runId: string }
) {
  const sync = sixb.definitions.syncs.getById(input.syncId)
  if (!sync) throw new Error(`[Test] Unknown Sync '${input.syncId}'.`)
  const executionId = `exec:${input.runId}`
  await sixb.storage.executions.create({
    id: executionId,
    projectId: sixb.id,
    executor: { type: "primitive", kind: "sync", runId: input.runId },
    source: { type: "schedule", eventId: `event:${input.runId}` },
    correlationId: `correlation:${input.runId}`,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "sync", id: input.syncId, runId: input.runId },
    },
  })
  await sixb.storage.syncRuns!.queue({
    id: input.runId,
    projectId: sixb.id,
    executionId,
    syncId: input.syncId,
    datasetId: sync.target.dataset.id,
    mode: sync.config.mode,
  })
  return sixb.queues.syncRuns.enqueue({
    projectId: sixb.id,
    jobs: [
      {
        id: input.runId,
        type: "sync.run.requested",
        payload: { runId: input.runId },
      },
    ],
  })
}

describe("SyncWorker", () => {
  test("defaults to one concurrent job and accepts an explicit limit", () => {
    const dataset = makeDataset("raw.erp.concurrency-options")
    const sync = defineSync("sync-concurrency-options")
      .from(erpDb)
      .read(() => [])
      .intoDataset(dataset)
    const sixb = createSixbForSync(sync)

    expect(new SyncWorker(sixb).concurrency).toBe(1)
    expect(new SyncWorker(sixb, { concurrency: 3 }).concurrency).toBe(3)
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
    const sixb = createSixbForSync(sync, (error, context) => {
      reports.push({ error, context })
    })
    let settledFailure: unknown
    const fail = sixb.queues.syncRuns.fail.bind(sixb.queues.syncRuns)
    sixb.queues.syncRuns.fail = async (input) => {
      settledFailure = input.failure
      await fail(input)
    }
    const worker = new SyncWorker(sixb)

    await enqueueSyncRun(sixb, { syncId: sync.id, runId: "run-failed" })

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
      await waitFor(
        async () => settledFailure,
        (failure) => failure !== undefined
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
      expect(settledFailure).toEqual(run!.error)

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

    await enqueueSyncRun(sixb, { syncId: "sync-logged", runId: "run-log" })

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
    const sixb = createSixbForSync(sync, () => {
      reportCount += 1
    })
    const worker = new SyncWorker(sixb)

    const [queued] = await enqueueSyncRun(sixb, {
      syncId: "sync-orders",
      runId: "run-retry",
    })

    await worker.start()

    await waitFor(
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-retry" }),
      (value) => value?.status === "running"
    )

    await worker.stop()

    const stopped = await sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-retry" })
    expect(stopped).toMatchObject({ status: "running", attempt: 0 })
    expect(stopped?.execution?.queueLeaseExpiresAt.getTime()).toBeLessThanOrEqual(Date.now())

    const [retried] = await sixb.queues.syncRuns.claim({
      projectId: sixb.id,
      workerId: "observer",
    })

    expect(retried?.job.id).toBe(queued?.id)
    expect(retried?.job.attempt).toBe(2)
    expect(await sixb.events.read({ types: ["sync.run.finished"] })).toEqual([])
    expect(reportCount).toBe(0)
  })

  test("emits sync run lifecycle events after a succeeded sync run", async () => {
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [{ orderId: "ord_1" }])
      .intoDataset(defineDataset("raw.erp.orders", { schema: [col("orderId", "string")] }))
    const sixb = createSixbForSync(sync)
    const worker = new SyncWorker(sixb)

    await enqueueSyncRun(sixb, { syncId: "sync-orders", runId: "run-emit" })

    await worker.start()

    const events = await waitForFinishedEvents(sixb, 1)
    await worker.stop()
    const run = await sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-emit" })

    expect(run).toMatchObject({ status: "succeeded", rowsRead: 1 })
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

    await enqueueSyncRun(sixb, { syncId: sync.id, runId: "run-merge-created" })
    await worker.start()
    const createdRun = await waitFor(
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-merge-created" }),
      (run) => run?.status === "succeeded"
    )

    await enqueueSyncRun(sixb, { syncId: sync.id, runId: "run-merge-noop" })
    const events = await waitForFinishedEvents(sixb, 2)
    await worker.stop()
    const noOpRun = await sixb.storage.syncRuns!.getById({
      projectId: sixb.id,
      id: "run-merge-noop",
    })

    expect(createdRun?.checkpoint).toEqual(storedErpCheckpoint("cursor-1"))
    expect(noOpRun?.checkpoint).toEqual(storedErpCheckpoint("cursor-2"))
    expect(noOpRun?.output?.versionId).toBe(createdRun?.output?.versionId)
    expect(events.map((event) => event.type)).toEqual([
      "sync.run.started",
      "dataset.version.committed",
      "sync.run.finished",
      "sync.run.started",
      "sync.run.finished",
    ])
    // The no-op still reports the version it reused; only a created version is announced.
    expect(events[4]?.payload).toMatchObject({
      runId: "run-merge-noop",
      status: "succeeded",
      versionId: createdRun?.output?.versionId,
    })
  })

  test("says whether a dataset version it announces changed rows or lineage", async () => {
    // Red check: emit `rowsChanged: true` instead of the created version's flag.
    const dataset = defineDataset("raw.erp.sequenced-orders", {
      schema: [col("orderId", "string"), col("revision", "int64")],
      primaryKey: "orderId",
      sequenceBy: "revision",
    })
    let reads = 0
    const sync = defineSync("sync-sequenced-orders", { mode: "merge" })
      .from(erpDb)
      .read(() => {
        reads += 1

        // The second run only deletes an order the dataset never held: it advances ordering.
        return reads === 1
          ? [change.upsert({ orderId: "ord_1", revision: 1 })]
          : [change.delete({ orderId: "ord_9" }, { sequence: 2 })]
      })
      .intoDataset(dataset)
    const sixb = createSixbForSync(sync)
    const worker = new SyncWorker(sixb)

    await enqueueSyncRun(sixb, { syncId: sync.id, runId: "run-rows" })
    await worker.start()
    await waitForFinishedEvents(sixb, 1)
    await enqueueSyncRun(sixb, { syncId: sync.id, runId: "run-ordering" })
    const events = await waitForFinishedEvents(sixb, 2)
    await worker.stop()

    const announced = events.flatMap((event) =>
      event.type === "dataset.version.committed"
        ? [{ rowsChanged: event.payload.rowsChanged, lineageChanged: event.payload.lineageChanged }]
        : []
    )
    expect(announced).toEqual([
      { rowsChanged: true, lineageChanged: true },
      { rowsChanged: false, lineageChanged: false },
    ])
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

    await enqueueSyncRun(sixb, { syncId: sync.id, runId: "run-first-empty" })

    await worker.start()
    const events = await waitForFinishedEvents(sixb, 1)
    await worker.stop()
    const run = await sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "run-first-empty" })

    expect(run?.output).toBeUndefined()
    expect(run?.checkpoint).toEqual(storedErpCheckpoint("cursor-1"))
    expect(events.map((event) => event.type)).toEqual(["sync.run.started", "sync.run.finished"])
    expect(events[1]?.payload).toEqual({
      syncId: sync.id,
      runId: "run-first-empty",
      status: "succeeded",
      datasetId: dataset.id,
    })
  })

  // Automatic dispatch joins a queued run, so its job must not end while the run stays queued, and
  // the job's delivery count says nothing about a run that has spent nothing. Fail the run from
  // `onExecutionError` to watch every trigger that joined it get dropped by one storage error.
  test.each([
    [1, 1_000],
    [2, 2_000],
    [40, 60_000],
  ])("retries attempt %i of a job that could not take its run after %i ms", async (attempt, delayMs) => {
    const fixture = await createUnstartedRunFixture()
    fixture.failBeforeStart()
    await fixture.spendAttempts(attempt - 1)

    const before = Date.now()
    await fixture.runWorkerUntilSettled()
    const after = Date.now()

    expect(fixture.settled).toEqual([{ kind: "retry", availableAt: expect.any(String) }])
    const availableAt = Date.parse(fixture.settled[0]?.availableAt ?? "")
    expect(availableAt).toBeGreaterThanOrEqual(before + delayMs)
    expect(availableAt).toBeLessThanOrEqual(after + delayMs)
    expect(await fixture.readRun()).toMatchObject({ status: "queued" })
    expect(fixture.reports).toEqual([])
  })

  // Treat a settled claim as a start in `execute` to watch the late job run the sync again.
  test("completes the job of a trigger that joined a run another job already ran", async () => {
    const fixture = await createUnstartedRunFixture()
    await fixture.sixb.queues.syncRuns.enqueue({
      projectId: fixture.sixb.id,
      jobs: [
        {
          id: "run-never-starts:join:event-2",
          type: "sync.run.requested",
          payload: { runId: "run-never-starts" },
        },
      ],
    })

    await fixture.runWorkerUntilSettled(2)

    expect(await fixture.readRun()).toMatchObject({ status: "succeeded" })
    expect(fixture.settled).toEqual([{ kind: "complete" }, { kind: "complete" }])
    expect(await fixture.sixb.events.read({ types: ["sync.run.started"] })).toHaveLength(1)
    expect(fixture.reports).toEqual([])
  })
})

/** One queued Sync run with its own job, and a record of how the worker settles its jobs. */
async function createUnstartedRunFixture() {
  const reports: SixbErrorContext[] = []
  const sync = defineSync("sync-never-started")
    .from(erpDb)
    .read(() => [])
    .intoDataset(makeDataset("raw.erp.never-started"))
  const sixb = createSixbForSync(sync, (_error, context) => {
    reports.push(context)
  })
  const syncRuns = sixb.storage.syncRuns!
  const queue = sixb.queues.syncRuns
  await enqueueSyncRun(sixb, { syncId: sync.id, runId: "run-never-starts" })

  const settled: SettledJob[] = []
  const complete = queue.complete.bind(queue)
  const retry = queue.retry.bind(queue)
  const fail = queue.fail.bind(queue)
  queue.complete = async (input) => {
    settled.push({ kind: "complete" })
    await complete(input)
  }
  queue.retry = async (input) => {
    settled.push({ kind: "retry", availableAt: input.availableAt })
    await retry(input)
  }
  queue.fail = async (input) => {
    settled.push({ kind: "fail", failure: input.failure })
    await fail(input)
  }

  return {
    sixb,
    sync,
    reports,
    settled,
    readRun: () => syncRuns.getById({ projectId: sixb.id, id: "run-never-starts" }),

    failBeforeStart() {
      syncRuns.startOrReclaim = () => Promise.reject(new Error("storage unavailable"))
    },

    /** Claim and release the job as earlier deliveries would, so the worker sees a later attempt. */
    async spendAttempts(count: number) {
      for (let spent = 0; spent < count; spent += 1) {
        const [claimed] = await queue.claim({ projectId: sixb.id, workerId: "earlier" })
        if (!claimed) throw new Error("[Test] Expected the run's job to be claimable.")
        await retry({ projectId: sixb.id, jobId: claimed.job.id, leaseId: claimed.leaseId })
      }
    },

    async runWorkerUntilSettled(count = 1) {
      const worker = new SyncWorker(sixb)
      await worker.start()

      try {
        await waitFor(
          async () => settled.length,
          (settledCount) => settledCount >= count
        )
      } finally {
        await worker.stop()
      }
    },
  }
}

interface SettledJob {
  readonly kind: "complete" | "retry" | "fail"
  readonly availableAt?: string
  readonly failure?: unknown
}
