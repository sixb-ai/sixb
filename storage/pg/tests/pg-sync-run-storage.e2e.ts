import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { SyncRunError } from "@sixb/core/storage"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

describe("PgSyncRunStorage", () => {
  let storage: PostgresStorage

  beforeEach(async () => {
    ;({ storage } = await createTestStorage())
  })

  afterEach(async () => {
    await storage.dropSchema()
    await storage.close()
  })

  test("starts and finishes runs with checkpoints", async () => {
    await storage.syncRuns.start({
      id: "run-1",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-06T15:00:00.000Z"),
    })

    const finished = await storage.syncRuns.finish({
      id: "run-1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt: new Date("2026-04-06T15:00:01.280Z"),
      rowsRead: 1250,
      output: {
        datasetId: "raw.erp.orders",
        versionId: "ver_123",
      },
      checkpoint: {
        cursor: "cursor-2",
        seenIds: ["evt-1", "evt-2"],
      },
    })

    expect(finished.status).toBe("succeeded")
    expect(finished.output).toEqual({
      datasetId: "raw.erp.orders",
      versionId: "ver_123",
    })
    expect(finished.checkpoint).toEqual({
      cursor: "cursor-2",
      seenIds: ["evt-1", "evt-2"],
    })

    await storage.syncRuns.start({
      id: "run-null",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "append",
    })
    const nullFinished = await storage.syncRuns.finish({
      id: "run-null",
      projectId: "my-app",
      status: "succeeded",
      rowsRead: 0,
      output: {
        datasetId: "raw.erp.orders",
        versionId: "ver_null",
      },
      checkpoint: null,
    })
    const storedNull = await storage.syncRuns.getById({ projectId: "my-app", id: "run-null" })
    expect(nullFinished.checkpoint).toBeNull()
    expect(storedNull?.checkpoint).toBeNull()

    await storage.syncRuns.start({
      id: "run-empty",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "append",
    })
    const emptyFinished = await storage.syncRuns.finish({
      id: "run-empty",
      projectId: "my-app",
      status: "succeeded",
      rowsRead: 0,
      checkpoint: { cursor: "cursor-empty" },
    })
    expect(emptyFinished.output).toBeUndefined()
    expect(emptyFinished.checkpoint).toEqual({ cursor: "cursor-empty" })
  })

  test("stores failures and supports filtered paging", async () => {
    await storage.syncRuns.start({
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
      rowsRead: 23,
      error: {
        name: "Error",
        message: "Database connection lost",
      },
    })

    await storage.syncRuns.start({
      id: "run-2",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-06T16:00:00.000Z"),
    })

    await storage.syncRuns.start({
      id: "run-3",
      projectId: "my-app",
      syncId: "sync-customers",
      datasetId: "raw.crm.customers",
      mode: "append",
      startedAt: new Date("2026-04-06T17:00:00.000Z"),
    })

    const page = await storage.syncRuns.list({
      projectId: "my-app",
      statuses: ["running"],
      startedAfter: new Date("2026-04-06T15:30:00.000Z"),
      limit: 1,
      offset: 0,
    })

    expect(page.total).toBe(2)
    expect(page.hasMore).toBe(true)
    expect(page.runs.map((run) => run.id)).toEqual(["run-3"])

    const selectedSyncs = await storage.syncRuns.list({
      projectId: "my-app",
      syncIds: ["sync-customers"],
    })
    expect(selectedSyncs.total).toBe(1)
    expect(selectedSyncs.runs.map((run) => run.id)).toEqual(["run-3"])

    // An empty allowlist must deny all — never fall through to an unfiltered list.
    const noneAllowed = await storage.syncRuns.list({ projectId: "my-app", syncIds: [] })
    expect(noneAllowed).toEqual({ runs: [], hasMore: false, total: 0 })

    const failed = await storage.syncRuns.getById({
      projectId: "my-app",
      id: "run-1",
    })
    expect(failed?.error?.message).toBe("Database connection lost")
    expect(failed?.rowsRead).toBe(23)
  })

  test("lists the latest run for multiple sync ids", async () => {
    await storage.syncRuns.start({
      id: "run-orders-a",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-06T16:00:00.000Z"),
    })
    await storage.syncRuns.start({
      id: "run-orders-z",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-06T16:00:00.000Z"),
    })
    await storage.syncRuns.start({
      id: "run-customers",
      projectId: "my-app",
      syncId: "sync-customers",
      datasetId: "raw.crm.customers",
      mode: "append",
      startedAt: new Date("2026-04-06T15:00:00.000Z"),
    })
    await storage.syncRuns.start({
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

  test("rejects duplicates, missing runs, and mismatched success outputs", async () => {
    await storage.syncRuns.start({
      id: "run-1",
      projectId: "my-app",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
    })

    await expect(
      storage.syncRuns.start({
        id: "run-1",
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
        error: {
          message: "boom",
        },
      })
    ).rejects.toBeInstanceOf(SyncRunError)

    await expect(
      storage.syncRuns.finish({
        id: "run-1",
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
