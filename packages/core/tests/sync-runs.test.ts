import { describe, expect, test } from "bun:test"
import { InMemorySyncRunStorage, SyncRunError } from "../src/storage"

describe("InMemorySyncRunStorage", () => {
  test("starts and finishes a successful run with a checkpoint", async () => {
    const storage = new InMemorySyncRunStorage()
    const startedAt = new Date("2026-04-06T15:00:00.000Z")
    const finishedAt = new Date("2026-04-06T15:00:01.280Z")

    const started = await storage.start({
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
    const finished = await storage.finish({
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

    const stored = await storage.getById({
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
    expect(stored?.startedAt.toISOString()).toBe(startedAt.toISOString())
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
    const storage = new InMemorySyncRunStorage()
    await storage.start({
      id: "syncrun_empty",
      projectId: "my-app",
      syncId: "sync-events",
      datasetId: "raw.erp.events",
      mode: "append",
    })

    const finished = await storage.finish({
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

  test("stores a successful empty snapshot without an output version", async () => {
    const storage = new InMemorySyncRunStorage()
    await storage.start({
      id: "syncrun_empty_snapshot",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
    })

    const finished = await storage.finish({
      id: "syncrun_empty_snapshot",
      projectId: "my-app",
      status: "succeeded",
      rowsRead: 0,
    })

    expect(finished).toMatchObject({ status: "succeeded", rowsRead: 0 })
    expect(finished.output).toBeUndefined()
  })

  test("rejects duplicate starts and missing finishes", async () => {
    const storage = new InMemorySyncRunStorage()

    await storage.start({
      id: "syncrun_1",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
    })

    await expect(
      storage.start({
        id: "syncrun_1",
        projectId: "my-app",
        syncId: "sync-orders",
        datasetId: "raw.erp.orders",
        mode: "snapshot",
      })
    ).rejects.toBeInstanceOf(SyncRunError)

    await expect(
      storage.finish({
        id: "missing",
        projectId: "my-app",
        status: "failed",
        error: {
          message: "boom",
        },
      })
    ).rejects.toBeInstanceOf(SyncRunError)
  })

  test("stores failed runs and lists with filters, ordering, and paging", async () => {
    const storage = new InMemorySyncRunStorage()

    await storage.start({
      id: "run-1",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-06T15:00:00.000Z"),
    })
    await storage.finish({
      id: "run-1",
      projectId: "my-app",
      status: "failed",
      finishedAt: new Date("2026-04-06T15:00:00.420Z"),
      rowsRead: 23,
      error: {
        name: "Error",
        message: "Database connection lost",
      },
    })

    await storage.start({
      id: "run-2",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-06T16:00:00.000Z"),
    })
    await storage.finish({
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

    await storage.start({
      id: "run-3",
      projectId: "my-app",
      syncId: "sync-customers",
      datasetId: "raw.crm.customers",
      mode: "append",
      startedAt: new Date("2026-04-06T17:00:00.000Z"),
    })

    const page = await storage.list({
      projectId: "my-app",
      statuses: ["running", "succeeded"],
      startedAfter: new Date("2026-04-06T15:30:00.000Z"),
      limit: 1,
      offset: 1,
    })

    expect(page.total).toBe(2)
    expect(page.hasMore).toBe(false)
    expect(page.runs.map((run) => run.id)).toEqual(["run-2"])

    const selectedSyncs = await storage.list({
      projectId: "my-app",
      syncIds: ["sync-customers"],
    })

    expect(selectedSyncs.runs.map((run) => run.id)).toEqual(["run-3"])
    expect(selectedSyncs.total).toBe(1)

    // An empty allowlist must deny all — never fall through to an unfiltered list.
    const noneAllowed = await storage.list({ projectId: "my-app", syncIds: [] })
    expect(noneAllowed).toEqual({ runs: [], hasMore: false, total: 0 })

    const failed = await storage.getById({
      projectId: "my-app",
      id: "run-1",
    })

    expect(failed?.status).toBe("failed")
    expect(failed?.rowsRead).toBe(23)
    expect(failed?.error).toEqual({
      name: "Error",
      message: "Database connection lost",
    })
  })

  test("lists the latest run for multiple sync ids", async () => {
    const storage = new InMemorySyncRunStorage()

    await storage.start({
      id: "run-orders-a",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-06T16:00:00.000Z"),
    })
    await storage.start({
      id: "run-orders-z",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-06T16:00:00.000Z"),
    })
    await storage.start({
      id: "run-customers",
      projectId: "my-app",
      syncId: "sync-customers",
      datasetId: "raw.crm.customers",
      mode: "append",
      startedAt: new Date("2026-04-06T15:00:00.000Z"),
    })
    await storage.start({
      id: "run-other-project",
      projectId: "other-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-06T17:00:00.000Z"),
    })

    const latest = await storage.listLatestBySyncIds({
      projectId: "my-app",
      syncIds: ["sync-customers", "sync-missing", "sync-orders", "sync-orders"],
    })

    expect(latest.runs.map((run) => run.id)).toEqual(["run-customers", "run-orders-z"])
  })

  test("rejects success outputs for a different dataset", async () => {
    const storage = new InMemorySyncRunStorage()

    await storage.start({
      id: "syncrun_1",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
    })

    await expect(
      storage.finish({
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
})
