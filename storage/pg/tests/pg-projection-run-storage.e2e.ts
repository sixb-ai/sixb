import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ProjectionRunError } from "@sixb/core/storage"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

describe("PgProjectionRunStorage", () => {
  let storage: PostgresStorage

  beforeEach(async () => {
    ;({ storage } = await createTestStorage())
  })

  afterEach(async () => {
    await storage.dropSchema()
    await storage.close()
  })

  test("starts, updates, and finishes runs", async () => {
    await storage.projectionRuns.start({
      id: "run-1",
      projectId: "my-app",
      projectionId: "customer-proj",
      projectionKind: "object",
      datasetId: "canonical.customers",
      datasetVersionId: "ver_123",
      startedAt: new Date("2026-04-06T15:00:00.000Z"),
    })

    await storage.projectionRuns.update({
      id: "run-1",
      projectId: "my-app",
      rowsProcessed: 10,
      objectsUpserted: 8,
      telemetryPointsAppended: 3,
      telemetryPointsSkipped: 1,
    })

    const finished = await storage.projectionRuns.finish({
      id: "run-1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt: new Date("2026-04-06T15:00:01.280Z"),
      rowsProcessed: 12,
      objectsUpserted: 10,
    })

    expect(finished).toMatchObject({
      id: "run-1",
      projectId: "my-app",
      projectionId: "customer-proj",
      projectionKind: "object",
      datasetId: "canonical.customers",
      datasetVersionId: "ver_123",
      status: "succeeded",
      rowsProcessed: 12,
      rowsSkipped: 0,
      objectsUpserted: 10,
      linksUpserted: 0,
      telemetryPointsAppended: 3,
      telemetryPointsSkipped: 1,
      telemetryRowsFailed: 0,
    })
    expect(finished.startedAt.toISOString()).toBe("2026-04-06T15:00:00.000Z")
    expect(finished.finishedAt?.toISOString()).toBe("2026-04-06T15:00:01.280Z")
  })

  test("stores failures and supports filtered paging", async () => {
    await storage.projectionRuns.start({
      id: "run-1",
      projectId: "my-app",
      projectionId: "customer-proj",
      projectionKind: "object",
      datasetId: "canonical.customers",
      datasetVersionId: "ver_1",
      startedAt: new Date("2026-04-06T15:00:00.000Z"),
    })
    await storage.projectionRuns.finish({
      id: "run-1",
      projectId: "my-app",
      status: "failed",
      rowsProcessed: 3,
      rowsSkipped: 1,
      errorMessage: "Invalid customer row",
    })

    await storage.projectionRuns.start({
      id: "run-2",
      projectId: "my-app",
      projectionId: "customer-proj",
      projectionKind: "object",
      datasetId: "canonical.customers",
      datasetVersionId: "ver_2",
      startedAt: new Date("2026-04-06T16:00:00.000Z"),
    })

    await storage.projectionRuns.start({
      id: "run-3",
      projectId: "my-app",
      projectionId: "project-members",
      projectionKind: "link",
      datasetId: "canonical.project-members",
      datasetVersionId: "ver_3",
      startedAt: new Date("2026-04-06T17:00:00.000Z"),
    })

    const page = await storage.projectionRuns.list({
      projectId: "my-app",
      statuses: ["running"],
      startedAfter: new Date("2026-04-06T15:30:00.000Z"),
      limit: 1,
      offset: 0,
    })

    expect(page.total).toBe(2)
    expect(page.hasMore).toBe(true)
    expect(page.runs.map((run) => run.id)).toEqual(["run-3"])

    const failed = await storage.projectionRuns.getById({
      projectId: "my-app",
      id: "run-1",
    })
    expect(failed?.errorMessage).toBe("Invalid customer row")
    expect(failed?.rowsProcessed).toBe(3)
    expect(failed?.rowsSkipped).toBe(1)
  })

  test("rejects duplicates, missing runs, terminal updates, and invalid counters", async () => {
    await storage.projectionRuns.start({
      id: "run-1",
      projectId: "my-app",
      projectionId: "customer-proj",
      projectionKind: "object",
      datasetId: "canonical.customers",
      datasetVersionId: "ver_1",
    })

    await expect(
      storage.projectionRuns.start({
        id: "run-1",
        projectId: "my-app",
        projectionId: "customer-proj",
        projectionKind: "object",
        datasetId: "canonical.customers",
        datasetVersionId: "ver_1",
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)

    await expect(
      storage.projectionRuns.finish({
        id: "missing",
        projectId: "my-app",
        status: "failed",
        errorMessage: "boom",
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)

    await storage.projectionRuns.finish({
      id: "run-1",
      projectId: "my-app",
      status: "cancelled",
      errorMessage: "cancelled",
    })

    await expect(
      storage.projectionRuns.update({
        id: "run-1",
        projectId: "my-app",
        rowsProcessed: 1,
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)

    await storage.projectionRuns.start({
      id: "run-2",
      projectId: "my-app",
      projectionId: "customer-proj",
      projectionKind: "object",
      datasetId: "canonical.customers",
      datasetVersionId: "ver_2",
    })

    await expect(
      storage.projectionRuns.update({
        id: "run-2",
        projectId: "my-app",
        telemetryRowsFailed: -1,
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)
  })
})
