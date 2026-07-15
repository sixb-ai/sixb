import { describe, expect, test } from "bun:test"
import { InMemoryProjectionRunStorage } from "../src"
import { ProjectionRunError } from "../src/storage"

describe("InMemoryProjectionRunStorage", () => {
  test("starts, updates, and finishes a successful run", async () => {
    const storage = new InMemoryProjectionRunStorage()
    const startedAt = new Date("2026-05-04T09:00:00.000Z")
    const finishedAt = new Date("2026-05-04T09:00:05.000Z")

    const started = await storage.start({
      id: "projrun_1",
      projectId: "my-app",
      projectionId: "rooms-projection",
      projectionKind: "object",
      datasetId: "canonical.rooms",
      datasetVersionId: "ver_1",
      startedAt,
    })

    started.startedAt.setUTCFullYear(2040)

    expect(started).toMatchObject({
      id: "projrun_1",
      projectId: "my-app",
      projectionId: "rooms-projection",
      projectionKind: "object",
      datasetId: "canonical.rooms",
      datasetVersionId: "ver_1",
      status: "running",
      rowsProcessed: 0,
      rowsSkipped: 0,
      objectsUpserted: 0,
      linksUpserted: 0,
      telemetryPointsAppended: 0,
      telemetryPointsSkipped: 0,
      telemetryRowsFailed: 0,
    })

    const updated = await storage.update({
      id: "projrun_1",
      projectId: "my-app",
      rowsProcessed: 10,
      rowsSkipped: 2,
      objectsUpserted: 8,
      telemetryPointsAppended: 3,
      telemetryPointsSkipped: 1,
    })

    expect(updated).toMatchObject({
      rowsProcessed: 10,
      rowsSkipped: 2,
      objectsUpserted: 8,
      linksUpserted: 0,
      telemetryPointsAppended: 3,
      telemetryPointsSkipped: 1,
      telemetryRowsFailed: 0,
      status: "running",
    })

    const finished = await storage.finish({
      id: "projrun_1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt,
      rowsProcessed: 12,
      objectsUpserted: 10,
      telemetryPointsAppended: 4,
      telemetryRowsFailed: 1,
    })

    const stored = await storage.getById({ projectId: "my-app", id: "projrun_1" })

    expect(finished).toMatchObject({
      status: "succeeded",
      rowsProcessed: 12,
      rowsSkipped: 2,
      objectsUpserted: 10,
      linksUpserted: 0,
      telemetryPointsAppended: 4,
      telemetryPointsSkipped: 1,
      telemetryRowsFailed: 1,
      errorMessage: undefined,
    })
    expect(stored?.startedAt.toISOString()).toBe(startedAt.toISOString())
    expect(stored?.finishedAt?.toISOString()).toBe(finishedAt.toISOString())
  })

  test("stores failed runs and lists with filters, ordering, and paging", async () => {
    const storage = new InMemoryProjectionRunStorage()

    await storage.start({
      id: "run-1",
      projectId: "my-app",
      projectionId: "rooms-projection",
      projectionKind: "object",
      datasetId: "canonical.rooms",
      datasetVersionId: "ver_1",
      startedAt: new Date("2026-05-04T09:00:00.000Z"),
    })
    await storage.finish({
      id: "run-1",
      projectId: "my-app",
      status: "failed",
      finishedAt: new Date("2026-05-04T09:00:01.000Z"),
      rowsProcessed: 5,
      rowsSkipped: 1,
      errorMessage: "Invalid row",
    })

    await storage.start({
      id: "run-2",
      projectId: "my-app",
      projectionId: "rooms-projection",
      projectionKind: "object",
      datasetId: "canonical.rooms",
      datasetVersionId: "ver_2",
      startedAt: new Date("2026-05-04T10:00:00.000Z"),
    })
    await storage.finish({
      id: "run-2",
      projectId: "my-app",
      status: "succeeded",
      rowsProcessed: 20,
      objectsUpserted: 20,
    })

    await storage.start({
      id: "run-3",
      projectId: "my-app",
      projectionId: "room-link-projection",
      projectionKind: "link",
      datasetId: "canonical.room-sensors",
      datasetVersionId: "ver_3",
      startedAt: new Date("2026-05-04T11:00:00.000Z"),
    })

    const page = await storage.list({
      projectId: "my-app",
      projectionKind: "object",
      datasetId: "canonical.rooms",
      statuses: ["running", "succeeded"],
      startedAfter: new Date("2026-05-04T09:30:00.000Z"),
      limit: 1,
      offset: 0,
    })

    expect(page.total).toBe(1)
    expect(page.hasMore).toBe(false)
    expect(page.runs.map((run) => run.id)).toEqual(["run-2"])

    const failed = await storage.getById({ projectId: "my-app", id: "run-1" })
    expect(failed?.status).toBe("failed")
    expect(failed?.rowsProcessed).toBe(5)
    expect(failed?.rowsSkipped).toBe(1)
    expect(failed?.errorMessage).toBe("Invalid row")
  })

  test("rejects duplicate starts, missing updates, and terminal rewrites", async () => {
    const storage = new InMemoryProjectionRunStorage()

    await storage.start({
      id: "run-1",
      projectId: "my-app",
      projectionId: "rooms-projection",
      projectionKind: "object",
      datasetId: "canonical.rooms",
      datasetVersionId: "ver_1",
    })

    await expect(
      storage.start({
        id: "run-1",
        projectId: "my-app",
        projectionId: "rooms-projection",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        datasetVersionId: "ver_1",
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)

    await expect(
      storage.update({
        id: "missing",
        projectId: "my-app",
        rowsProcessed: 1,
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)

    await storage.finish({
      id: "run-1",
      projectId: "my-app",
      status: "cancelled",
      errorMessage: "Stopped",
    })

    await expect(
      storage.update({
        id: "run-1",
        projectId: "my-app",
        rowsProcessed: 2,
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)

    await expect(
      storage.finish({
        id: "run-1",
        projectId: "my-app",
        status: "failed",
        errorMessage: "Too late",
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)
  })

  test("records object type ids and filters by the viewable set", async () => {
    const storage = new InMemoryProjectionRunStorage()
    const at = (minute: number) => new Date(`2026-05-04T09:0${minute}:00.000Z`)

    await storage.start({
      id: "object-run",
      projectId: "my-app",
      projectionId: "rooms-projection",
      projectionKind: "object",
      datasetId: "canonical.rooms",
      datasetVersionId: "ver_1",
      objectTypeId: "room",
      startedAt: at(0),
    })
    await storage.start({
      id: "link-run",
      projectId: "my-app",
      projectionId: "room-sensors",
      projectionKind: "link",
      datasetId: "canonical.room-sensors",
      datasetVersionId: "ver_1",
      sourceObjectTypeId: "room",
      targetObjectTypeId: "sensor",
      startedAt: at(1),
    })

    // Link runs require both ends viewable.
    const roomsOnly = await storage.list({ projectId: "my-app", objectTypeIds: ["room"] })
    expect(roomsOnly.runs.map((run) => run.id)).toEqual(["object-run"])

    const bothTypes = await storage.list({
      projectId: "my-app",
      objectTypeIds: ["room", "sensor"],
    })
    expect(bothTypes.runs.map((run) => run.id)).toEqual(["link-run", "object-run"])

    // An empty viewable set matches nothing.
    const none = await storage.list({ projectId: "my-app", objectTypeIds: [] })
    expect(none).toMatchObject({ runs: [], total: 0, hasMore: false })
  })

  test("lists the latest run per projection id", async () => {
    const storage = new InMemoryProjectionRunStorage()
    const at = (minute: number) => new Date(`2026-05-04T09:0${minute}:00.000Z`)

    for (const [id, projectionId, minute] of [
      ["a1", "alpha", 0],
      ["a2", "alpha", 2],
      ["b1", "beta", 1],
    ] as const) {
      await storage.start({
        id,
        projectId: "my-app",
        projectionId,
        projectionKind: "object",
        datasetId: "ds",
        datasetVersionId: "v",
        objectTypeId: "room",
        startedAt: at(minute),
      })
    }
    // Another project must not leak in.
    await storage.start({
      id: "other",
      projectId: "other-app",
      projectionId: "alpha",
      projectionKind: "object",
      datasetId: "ds",
      datasetVersionId: "v",
      startedAt: at(5),
    })

    const latest = await storage.listLatestByProjectionIds({
      projectId: "my-app",
      projectionIds: ["alpha", "beta", "missing"],
    })

    expect(latest.runs.map((run) => run.id)).toEqual(["a2", "b1"])
  })

  test("rejects invalid counters", async () => {
    const storage = new InMemoryProjectionRunStorage()

    await storage.start({
      id: "run-1",
      projectId: "my-app",
      projectionId: "rooms-projection",
      projectionKind: "object",
      datasetId: "canonical.rooms",
      datasetVersionId: "ver_1",
    })

    await expect(
      storage.update({
        id: "run-1",
        projectId: "my-app",
        rowsProcessed: -1,
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)

    await expect(
      storage.finish({
        id: "run-1",
        projectId: "my-app",
        status: "succeeded",
        telemetryRowsFailed: 1.5,
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)
  })
})
