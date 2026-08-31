import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import type { QueueSyncRunInput, SixbFailure, SyncRunFailureCode } from "../src/storage"
import { SyncRunError } from "../src/storage"
import { createTestSyncExecution } from "../src/testing"

type TestStartSyncRunInput = Omit<QueueSyncRunInput, "executionId" | "queuedAt"> & {
  readonly startedAt?: Date
}

async function startSyncRun(storage: InMemoryStorage, input: TestStartSyncRunInput) {
  const executionId = `exec:${input.projectId}:${input.id}`
  if (!(await storage.executions.getById({ projectId: input.projectId, id: executionId }))) {
    await storage.executions.create({
      id: executionId,
      projectId: input.projectId,
      executor: { type: "primitive", kind: "sync", runId: input.id },
      source: { type: "schedule", eventId: `event:${input.id}` },
      correlationId: `correlation:${input.id}`,
      authorizationRef: {
        type: "trustedPrimitive",
        primitive: { kind: "sync", id: input.syncId, runId: input.id },
      },
    })
  }
  const { startedAt, ...run } = input
  await storage.syncRuns.queue({
    ...run,
    executionId,
    queuedAt: startedAt,
  })
  return storage.syncRuns.start({ id: input.id, projectId: input.projectId, startedAt })
}

const FAILURE: SixbFailure<SyncRunFailureCode> = {
  code: "internal.unexpected",
  message: "Database connection lost",
  retryable: false,
  at: "2026-04-06T15:00:00.420Z",
  details: { provider: "erp" },
}

describe("InMemorySyncRunStorage", () => {
  test("starts and finishes a successful run with a checkpoint", async () => {
    const storage = new InMemoryStorage()
    const startedAt = new Date("2026-04-06T15:00:00.000Z")
    const finishedAt = new Date("2026-04-06T15:00:01.280Z")

    const started = await startSyncRun(storage, {
      id: "syncrun_1",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt,
      expectedLatestVersionId: "ver_prev",
      commitMessage: "refresh orders",
    })

    ;(started.startedAt as Date).setUTCFullYear(2040)

    const checkpoint = {
      cursor: "cursor-2",
      nested: {
        page: 2,
      },
    }
    const finished = await storage.syncRuns.finish({
      id: "syncrun_1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt,
      rowsRead: 1250,
      output: {
        datasetId: "raw.erp.orders",
        versionId: "ver_123",
      },
      checkpoint,
    })
    checkpoint.nested.page = 999

    const stored = await storage.syncRuns.getById({
      projectId: "my-app",
      id: "syncrun_1",
    })

    expect(finished.status).toBe("succeeded")
    expect(finished.rowsRead).toBe(1250)
    expect(finished.output).toEqual({
      datasetId: "raw.erp.orders",
      versionId: "ver_123",
    })
    expect(finished.checkpoint).toEqual({
      cursor: "cursor-2",
      nested: {
        page: 2,
      },
    })
    expect(stored?.startedAt?.toISOString()).toBe(startedAt.toISOString())
    expect(stored?.finishedAt?.toISOString()).toBe(finishedAt.toISOString())
    expect(stored?.commitMessage).toBe("refresh orders")
    expect(stored?.expectedLatestVersionId).toBe("ver_prev")
    expect(stored?.checkpoint).toEqual({
      cursor: "cursor-2",
      nested: {
        page: 2,
      },
    })
  })

  test("stores a checkpoint for a successful empty append without an output version", async () => {
    const storage = new InMemoryStorage()
    await startSyncRun(storage, {
      id: "syncrun_empty",
      projectId: "my-app",
      syncId: "sync-events",
      datasetId: "raw.erp.events",
      mode: "append",
    })

    const finished = await storage.syncRuns.finish({
      id: "syncrun_empty",
      projectId: "my-app",
      status: "succeeded",
      rowsRead: 0,
      checkpoint: { cursor: "cursor-1" },
    })

    expect(finished).toMatchObject({
      status: "succeeded",
      rowsRead: 0,
      checkpoint: { cursor: "cursor-1" },
    })
    expect(finished.output).toBeUndefined()
  })

  test("stores an initial merge no-op with consumed changes and no output version", async () => {
    const storage = new InMemoryStorage()
    const started = await startSyncRun(storage, {
      id: "syncrun_merge_noop",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "merge",
    })

    const finished = await storage.syncRuns.finish({
      id: started.id,
      projectId: started.projectId,
      status: "succeeded",
      rowsRead: 1,
      checkpoint: { cursor: "cursor-2" },
    })

    expect(finished).toMatchObject({
      mode: "merge",
      status: "succeeded",
      rowsRead: 1,
      checkpoint: { cursor: "cursor-2" },
    })
    expect(finished.output).toBeUndefined()
  })

  test("stores a successful empty snapshot without an output version", async () => {
    const storage = new InMemoryStorage()
    await startSyncRun(storage, {
      id: "syncrun_empty_snapshot",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
    })

    const finished = await storage.syncRuns.finish({
      id: "syncrun_empty_snapshot",
      projectId: "my-app",
      status: "succeeded",
      rowsRead: 0,
    })

    expect(finished).toMatchObject({ status: "succeeded", rowsRead: 0 })
    expect(finished.output).toBeUndefined()
  })

  test("rejects duplicate starts and missing finishes", async () => {
    const storage = new InMemoryStorage()

    await startSyncRun(storage, {
      id: "syncrun_1",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
    })

    await expect(
      startSyncRun(storage, {
        id: "syncrun_1",
        projectId: "my-app",
        syncId: "sync-orders",
        datasetId: "raw.erp.orders",
        mode: "snapshot",
      })
    ).rejects.toBeInstanceOf(SyncRunError)

    await expect(
      storage.syncRuns.finish({
        id: "missing",
        projectId: "my-app",
        status: "failed",
        error: { ...FAILURE, message: "boom" },
      })
    ).rejects.toBeInstanceOf(SyncRunError)
  })

  test("stores failed runs and lists with filters, ordering, and paging", async () => {
    const storage = new InMemoryStorage()

    await startSyncRun(storage, {
      id: "run-1",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-06T15:00:00.000Z"),
    })
    await storage.syncRuns.finish({
      id: "run-1",
      projectId: "my-app",
      status: "failed",
      finishedAt: new Date("2026-04-06T15:00:00.420Z"),
      rowsRead: 23,
      error: FAILURE,
    })

    await startSyncRun(storage, {
      id: "run-2",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-06T16:00:00.000Z"),
    })
    await storage.syncRuns.finish({
      id: "run-2",
      projectId: "my-app",
      status: "succeeded",
      finishedAt: new Date("2026-04-06T16:00:01.000Z"),
      rowsRead: 100,
      output: {
        datasetId: "raw.erp.orders",
        versionId: "ver_200",
      },
    })

    await startSyncRun(storage, {
      id: "run-3",
      projectId: "my-app",
      syncId: "sync-customers",
      datasetId: "raw.crm.customers",
      mode: "append",
      startedAt: new Date("2026-04-06T17:00:00.000Z"),
    })

    const page = await storage.syncRuns.list({
      projectId: "my-app",
      statuses: ["running", "succeeded"],
      startedAfter: new Date("2026-04-06T15:30:00.000Z"),
      limit: 1,
      offset: 1,
    })

    expect(page.total).toBe(2)
    expect(page.hasMore).toBe(false)
    expect(page.runs.map((run) => run.id)).toEqual(["run-2"])

    const selectedSyncs = await storage.syncRuns.list({
      projectId: "my-app",
      syncIds: ["sync-customers"],
    })

    expect(selectedSyncs.runs.map((run) => run.id)).toEqual(["run-3"])
    expect(selectedSyncs.total).toBe(1)

    // An empty allowlist must deny all — never fall through to an unfiltered list.
    const noneAllowed = await storage.syncRuns.list({ projectId: "my-app", syncIds: [] })
    expect(noneAllowed).toEqual({ runs: [], hasMore: false, total: 0 })

    const failed = await storage.syncRuns.getById({
      projectId: "my-app",
      id: "run-1",
    })

    expect(failed?.status).toBe("failed")
    expect(failed?.rowsRead).toBe(23)
    expect(failed?.error).toEqual(FAILURE)
  })

  test("lists the latest run for multiple sync ids", async () => {
    const storage = new InMemoryStorage()

    await startSyncRun(storage, {
      id: "run-orders-a",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-06T16:00:00.000Z"),
    })
    await startSyncRun(storage, {
      id: "run-orders-z",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-06T16:00:00.000Z"),
    })
    await startSyncRun(storage, {
      id: "run-customers",
      projectId: "my-app",
      syncId: "sync-customers",
      datasetId: "raw.crm.customers",
      mode: "append",
      startedAt: new Date("2026-04-06T15:00:00.000Z"),
    })
    await startSyncRun(storage, {
      id: "run-other-project",
      projectId: "other-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-06T17:00:00.000Z"),
    })

    const latest = await storage.syncRuns.listLatestBySyncIds({
      projectId: "my-app",
      syncIds: ["sync-customers", "sync-missing", "sync-orders", "sync-orders"],
    })

    expect(latest.runs.map((run) => run.id)).toEqual(["run-customers", "run-orders-z"])
  })

  test("rejects success outputs for a different dataset", async () => {
    const storage = new InMemoryStorage()

    await startSyncRun(storage, {
      id: "syncrun_1",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
    })

    await expect(
      storage.syncRuns.finish({
        id: "syncrun_1",
        projectId: "my-app",
        status: "succeeded",
        rowsRead: 10,
        output: {
          datasetId: "raw.erp.invoices",
          versionId: "ver_1",
        },
      })
    ).rejects.toBeInstanceOf(SyncRunError)
  })

  test("rejects a run whose execution authorizes a different Sync", async () => {
    const storage = new InMemoryStorage()
    const executionId = await createTestSyncExecution(storage.executions, {
      projectId: "my-app",
      syncId: "sync-customers",
      runId: "run-1",
    })

    await expect(
      storage.syncRuns.queue({
        id: "run-1",
        projectId: "my-app",
        executionId,
        syncId: "sync-orders",
        datasetId: "raw.erp.orders",
        mode: "snapshot",
      })
    ).rejects.toBeInstanceOf(SyncRunError)
  })
})
