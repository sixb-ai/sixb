import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ProjectionRunError } from "@sixb/core/storage"
import { SqliteProjectionRunStorage } from "../src/projection-run-storage"

type MaterializationIdentity = Parameters<
  SqliteProjectionRunStorage["startOrReclaimMaterialization"]
>[0]["identity"]

const replacementIdentity: MaterializationIdentity = {
  projectionId: "devices",
  projectionKind: "object",
  protocol: "replacement",
  datasetVersion: {
    datasetId: "canonical.devices",
    versionId: "v1",
    createdAt: "2026-04-06T14:00:00.000Z",
  },
  ontologyRevision: "ontology-1",
  projectionRevision: "projection-1",
  ownershipHash: "ownership-1",
}

const telemetryIdentity: MaterializationIdentity = {
  projectionId: "temperatures",
  projectionKind: "telemetry",
  protocol: "telemetry",
  datasetVersion: {
    datasetId: "canonical.readings",
    versionId: "v1",
    createdAt: "2026-04-06T14:00:00.000Z",
  },
  ontologyRevision: "ontology-1",
  projectionRevision: "projection-telemetry-1",
  ownershipHash: "ownership-telemetry-1",
}

describe("SqliteProjectionRunStorage", () => {
  let storage: SqliteProjectionRunStorage

  beforeEach(() => {
    storage = new SqliteProjectionRunStorage()
  })

  afterEach(() => {
    storage.close()
  })

  test("starts, updates, and finishes runs", async () => {
    await storage.start({
      id: "run-1",
      projectId: "my-app",
      projectionId: "customer-proj",
      projectionKind: "object",
      datasetId: "canonical.customers",
      datasetVersionId: "ver_123",
      startedAt: new Date("2026-04-06T15:00:00.000Z"),
    })

    await storage.update({
      id: "run-1",
      projectId: "my-app",
      sourceRowsRead: 10,
      sourceRowsSkipped: 1,
    })

    const finished = await storage.finish({
      id: "run-1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt: new Date("2026-04-06T15:00:01.280Z"),
      sourceRowsRead: 12,
    })

    expect(finished).toMatchObject({
      id: "run-1",
      projectId: "my-app",
      projectionId: "customer-proj",
      projectionKind: "object",
      datasetId: "canonical.customers",
      datasetVersionId: "ver_123",
      status: "succeeded",
      sourceRowsRead: 12,
      sourceRowsSkipped: 1,
    })
    expect(finished.startedAt.toISOString()).toBe("2026-04-06T15:00:00.000Z")
    expect(finished.finishedAt?.toISOString()).toBe("2026-04-06T15:00:01.280Z")
  })

  test("stores failures and supports filtered paging", async () => {
    await storage.start({
      id: "run-1",
      projectId: "my-app",
      projectionId: "customer-proj",
      projectionKind: "object",
      datasetId: "canonical.customers",
      datasetVersionId: "ver_1",
      startedAt: new Date("2026-04-06T15:00:00.000Z"),
    })
    await storage.finish({
      id: "run-1",
      projectId: "my-app",
      status: "failed",
      sourceRowsRead: 3,
      sourceRowsSkipped: 1,
      errorMessage: "Invalid customer row",
    })

    await storage.start({
      id: "run-2",
      projectId: "my-app",
      projectionId: "customer-proj",
      projectionKind: "object",
      datasetId: "canonical.customers",
      datasetVersionId: "ver_2",
      startedAt: new Date("2026-04-06T16:00:00.000Z"),
    })

    await storage.start({
      id: "run-3",
      projectId: "my-app",
      projectionId: "project-members",
      projectionKind: "link",
      datasetId: "canonical.project-members",
      datasetVersionId: "ver_3",
      startedAt: new Date("2026-04-06T17:00:00.000Z"),
    })

    const page = await storage.list({
      projectId: "my-app",
      statuses: ["running"],
      startedAfter: new Date("2026-04-06T15:30:00.000Z"),
      limit: 1,
      offset: 0,
    })

    expect(page.total).toBe(2)
    expect(page.hasMore).toBe(true)
    expect(page.runs.map((run) => run.id)).toEqual(["run-3"])

    const failed = await storage.getById({
      projectId: "my-app",
      id: "run-1",
    })
    expect(failed?.errorMessage).toBe("Invalid customer row")
    expect(failed?.sourceRowsRead).toBe(3)
    expect(failed?.sourceRowsSkipped).toBe(1)
  })

  test("records object type ids, filters by viewable set, and lists latest per projection", async () => {
    await storage.start({
      id: "object-run",
      projectId: "my-app",
      projectionId: "rooms",
      projectionKind: "object",
      datasetId: "ds.rooms",
      datasetVersionId: "ver_1",
      objectTypeId: "room",
      startedAt: new Date("2026-04-06T15:00:00.000Z"),
    })
    await storage.start({
      id: "rooms-run-2",
      projectId: "my-app",
      projectionId: "rooms",
      projectionKind: "object",
      datasetId: "ds.rooms",
      datasetVersionId: "ver_2",
      objectTypeId: "room",
      startedAt: new Date("2026-04-06T16:00:00.000Z"),
    })
    await storage.start({
      id: "link-run",
      projectId: "my-app",
      projectionId: "room-sensors",
      projectionKind: "link",
      datasetId: "ds.room-sensors",
      datasetVersionId: "ver_1",
      sourceObjectTypeId: "room",
      targetObjectTypeId: "sensor",
      startedAt: new Date("2026-04-06T17:00:00.000Z"),
    })

    const stored = await storage.getById({ projectId: "my-app", id: "link-run" })
    expect(stored).toMatchObject({ sourceObjectTypeId: "room", targetObjectTypeId: "sensor" })

    // Link runs need both ends; "room" alone excludes them.
    const roomsOnly = await storage.list({ projectId: "my-app", objectTypeIds: ["room"] })
    expect(roomsOnly.runs.map((run) => run.id)).toEqual(["rooms-run-2", "object-run"])

    const both = await storage.list({ projectId: "my-app", objectTypeIds: ["room", "sensor"] })
    expect(both.total).toBe(3)

    const none = await storage.list({ projectId: "my-app", objectTypeIds: [] })
    expect(none).toMatchObject({ runs: [], total: 0, hasMore: false })

    const latest = await storage.listLatestByProjectionIds({
      projectId: "my-app",
      projectionIds: ["rooms", "room-sensors", "missing"],
    })
    expect(latest.runs.map((run) => run.id)).toEqual(["rooms-run-2", "link-run"])
  })

  test("reclaims one stable materialization run with full identity and a fresh UUID token", async () => {
    const input = {
      id: "materialization-run",
      projectId: "my-app",
      identity: replacementIdentity,
      objectTypeId: "Device",
      startedAt: new Date("2026-04-06T15:00:00.000Z"),
    } as const

    const first = await storage.startOrReclaimMaterialization(input)
    expect(first).toMatchObject({
      id: input.id,
      attempt: 1,
      materializationProtocol: "replacement",
      datasetVersionCreatedAt: replacementIdentity.datasetVersion.createdAt,
      ontologyRevision: replacementIdentity.ontologyRevision,
      projectionRevision: replacementIdentity.projectionRevision,
      ownershipHash: replacementIdentity.ownershipHash,
      objectTypeId: "Device",
    })
    expect(first.executionToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )

    await storage.updateMaterialization({
      id: input.id,
      projectId: input.projectId,
      identity: replacementIdentity,
      executionToken: first.executionToken,
      sourceRowsRead: 7,
    })
    const second = await storage.startOrReclaimMaterialization(input)
    expect(second).toMatchObject({
      id: first.id,
      attempt: 2,
      sourceRowsRead: 7,
      startedAt: first.startedAt,
    })
    expect(second.executionToken).not.toBe(first.executionToken)
    expect(second.executionToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )

    const publicRecord = await storage.getById({ projectId: input.projectId, id: input.id })
    expect(publicRecord).not.toHaveProperty("executionToken")
    expect(publicRecord).toMatchObject({
      attempt: 2,
      materializationProtocol: "replacement",
      datasetVersionCreatedAt: replacementIdentity.datasetVersion.createdAt,
      ontologyRevision: replacementIdentity.ontologyRevision,
      projectionRevision: replacementIdentity.projectionRevision,
      ownershipHash: replacementIdentity.ownershipHash,
    })
  })

  test("rejects reclaim identity, target, and fixed-batch changes without rotating ownership", async () => {
    const replacement = await storage.startOrReclaimMaterialization({
      id: "replacement-run",
      projectId: "my-app",
      identity: replacementIdentity,
      objectTypeId: "Device",
    })

    for (const identity of [
      { ...replacementIdentity, projectionId: "other" },
      {
        ...replacementIdentity,
        datasetVersion: { ...replacementIdentity.datasetVersion, datasetId: "other" },
      },
      {
        ...replacementIdentity,
        datasetVersion: { ...replacementIdentity.datasetVersion, versionId: "other" },
      },
      {
        ...replacementIdentity,
        datasetVersion: {
          ...replacementIdentity.datasetVersion,
          createdAt: "2026-04-06T14:00:01.000Z",
        },
      },
      { ...replacementIdentity, ontologyRevision: "other" },
      { ...replacementIdentity, projectionRevision: "other" },
      { ...replacementIdentity, ownershipHash: "other" },
    ] satisfies MaterializationIdentity[]) {
      await expect(
        storage.startOrReclaimMaterialization({
          id: "replacement-run",
          projectId: "my-app",
          identity,
          objectTypeId: "Device",
        })
      ).rejects.toThrow("materialization identity does not match")
    }
    await expect(
      storage.startOrReclaimMaterialization({
        id: "replacement-run",
        projectId: "my-app",
        identity: replacementIdentity,
        objectTypeId: "Other",
      })
    ).rejects.toThrow("target object types do not match")
    await expect(
      storage.assertMaterializationExecution({
        id: "replacement-run",
        projectId: "my-app",
        identity: replacementIdentity,
        executionToken: replacement.executionToken,
      })
    ).resolves.toMatchObject({ attempt: 1 })

    const telemetry = await storage.startOrReclaimMaterialization({
      id: "telemetry-run",
      projectId: "my-app",
      identity: telemetryIdentity,
      objectTypeId: "Device",
      fixedBatchSize: 2,
    })
    await expect(
      storage.startOrReclaimMaterialization({
        id: "telemetry-run",
        projectId: "my-app",
        identity: telemetryIdentity,
        objectTypeId: "Device",
        fixedBatchSize: 3,
      })
    ).rejects.toThrow("fixed batch size does not match")
    await expect(
      storage.assertMaterializationExecution({
        id: "telemetry-run",
        projectId: "my-app",
        identity: telemetryIdentity,
        executionToken: telemetry.executionToken,
      })
    ).resolves.toMatchObject({ attempt: 1 })
  })

  test("fences every materialization mutation with the current execution token", async () => {
    const input = {
      id: "telemetry-run",
      projectId: "my-app",
      identity: telemetryIdentity,
      objectTypeId: "Device",
      fixedBatchSize: 2,
    } as const
    const first = await storage.startOrReclaimMaterialization(input)
    const current = await storage.startOrReclaimMaterialization(input)
    const staleExecution = {
      id: input.id,
      projectId: input.projectId,
      identity: telemetryIdentity,
      executionToken: first.executionToken,
    } as const

    const staleOperations = [
      storage.assertMaterializationExecution(staleExecution),
      storage.updateMaterialization({ ...staleExecution, sourceRowsRead: 0 }),
      storage.advanceTelemetryCheckpoint({
        ...staleExecution,
        batchOrdinal: 0,
        batchRowCount: 2,
        batchRowsSkipped: 0,
        inputExhausted: false,
      }),
      storage.completeTelemetryInput(staleExecution),
      storage.finishMaterialization({ ...staleExecution, status: "cancelled" }),
    ]
    for (const operation of staleOperations) {
      try {
        await operation
        throw new Error("Expected stale execution to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectionRunError)
        expect((error as ProjectionRunError).kind).toBe("execution-lost")
      }
    }

    await expect(
      storage.updateMaterialization({
        ...staleExecution,
        executionToken: current.executionToken,
        sourceRowsRead: 0,
      })
    ).resolves.toMatchObject({ sourceRowsRead: 0 })
    await expect(
      storage.update({ id: input.id, projectId: input.projectId, sourceRowsRead: 2 })
    ).rejects.toThrow("use updateMaterialization()")
    await expect(
      storage.finish({ id: input.id, projectId: input.projectId, status: "cancelled" })
    ).rejects.toThrow("use finishMaterialization()")
  })

  test("persists and guards the telemetry fixed-batch checkpoint", async () => {
    const run = await storage.startOrReclaimMaterialization({
      id: "telemetry-run",
      projectId: "my-app",
      identity: telemetryIdentity,
      objectTypeId: "Device",
      fixedBatchSize: 2,
    })
    const execution = {
      id: run.id,
      projectId: run.projectId,
      identity: telemetryIdentity,
      executionToken: run.executionToken,
    } as const

    expect(run.telemetryCheckpoint).toEqual({
      fixedBatchSize: 2,
      nextBatchOrdinal: 0,
      nextRowOffset: 0,
      inputExhausted: false,
    })
    await expect(
      storage.advanceTelemetryCheckpoint({
        ...execution,
        batchOrdinal: 0,
        batchRowCount: 1,
        batchRowsSkipped: 0,
        inputExhausted: false,
      })
    ).rejects.toThrow("partial non-final batch")
    await expect(
      storage.advanceTelemetryCheckpoint({
        ...execution,
        batchOrdinal: 1,
        batchRowCount: 2,
        batchRowsSkipped: 0,
        inputExhausted: false,
      })
    ).rejects.toThrow("expected batch ordinal 0")
    await expect(
      storage.advanceTelemetryCheckpoint({
        ...execution,
        batchOrdinal: 0,
        batchRowCount: 3,
        batchRowsSkipped: 0,
        inputExhausted: true,
      })
    ).rejects.toThrow("exceeds its fixed size")

    await storage.advanceTelemetryCheckpoint({
      ...execution,
      batchOrdinal: 0,
      batchRowCount: 2,
      batchRowsSkipped: 0,
      inputExhausted: false,
    })
    const reclaimed = await storage.startOrReclaimMaterialization({
      id: run.id,
      projectId: run.projectId,
      identity: telemetryIdentity,
      objectTypeId: "Device",
      fixedBatchSize: 2,
    })
    expect(reclaimed.telemetryCheckpoint).toEqual({
      fixedBatchSize: 2,
      nextBatchOrdinal: 1,
      nextRowOffset: 2,
      inputExhausted: false,
    })
    await expect(
      storage.completeTelemetryInput({
        ...execution,
        executionToken: reclaimed.executionToken,
      })
    ).resolves.toMatchObject({ telemetryCheckpoint: { inputExhausted: true } })
    await expect(
      storage.finishMaterialization({
        ...execution,
        executionToken: reclaimed.executionToken,
        status: "succeeded",
      })
    ).resolves.toMatchObject({
      status: "succeeded",
      telemetryCheckpoint: { nextBatchOrdinal: 1, nextRowOffset: 2, inputExhausted: true },
    })
    await expect(
      storage.startOrReclaimMaterialization({
        id: run.id,
        projectId: run.projectId,
        identity: telemetryIdentity,
        objectTypeId: "Device",
        fixedBatchSize: 2,
      })
    ).rejects.toThrow("already terminal")
  })

  test("requires explicit telemetry exhaustion, including empty input", async () => {
    const run = await storage.startOrReclaimMaterialization({
      id: "empty-telemetry-run",
      projectId: "my-app",
      identity: telemetryIdentity,
      objectTypeId: "Device",
      fixedBatchSize: 100,
    })
    const execution = {
      id: run.id,
      projectId: run.projectId,
      identity: telemetryIdentity,
      executionToken: run.executionToken,
    } as const

    await expect(
      storage.finishMaterialization({ ...execution, status: "succeeded" })
    ).rejects.toThrow("before its input is exhausted")
    await storage.completeTelemetryInput(execution)
    await expect(storage.completeTelemetryInput(execution)).resolves.toMatchObject({
      telemetryCheckpoint: { inputExhausted: true },
    })
    await expect(
      storage.finishMaterialization({ ...execution, status: "succeeded" })
    ).resolves.toMatchObject({
      status: "succeeded",
      telemetryCheckpoint: { nextBatchOrdinal: 0, nextRowOffset: 0, inputExhausted: true },
    })
  })

  test("validates materialization identity, protocol targets, and counters with typed errors", async () => {
    await expect(
      storage.startOrReclaimMaterialization({
        id: "bad-time",
        projectId: "my-app",
        identity: {
          ...replacementIdentity,
          datasetVersion: { ...replacementIdentity.datasetVersion, createdAt: "not-a-time" },
        },
        objectTypeId: "Device",
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)
    await expect(
      storage.startOrReclaimMaterialization({
        id: "missing-target",
        projectId: "my-app",
        identity: replacementIdentity,
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)
    await expect(
      storage.startOrReclaimMaterialization({
        id: "replacement-batch",
        projectId: "my-app",
        identity: replacementIdentity,
        objectTypeId: "Device",
        fixedBatchSize: 2,
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)
    await expect(
      storage.startOrReclaimMaterialization({
        id: "bad-batch",
        projectId: "my-app",
        identity: telemetryIdentity,
        objectTypeId: "Device",
        fixedBatchSize: 0,
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)

    const run = await storage.startOrReclaimMaterialization({
      id: "safe-counter-run",
      projectId: "my-app",
      identity: replacementIdentity,
      objectTypeId: "Device",
    })
    await expect(
      storage.updateMaterialization({
        id: run.id,
        projectId: run.projectId,
        identity: replacementIdentity,
        executionToken: run.executionToken,
        sourceRowsRead: Number.MAX_SAFE_INTEGER + 1,
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)
  })

  test("rejects duplicates, missing runs, terminal updates, and invalid counters", async () => {
    await storage.start({
      id: "run-1",
      projectId: "my-app",
      projectionId: "customer-proj",
      projectionKind: "object",
      datasetId: "canonical.customers",
      datasetVersionId: "ver_1",
    })

    await expect(
      storage.start({
        id: "run-1",
        projectId: "my-app",
        projectionId: "customer-proj",
        projectionKind: "object",
        datasetId: "canonical.customers",
        datasetVersionId: "ver_1",
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)

    await expect(
      storage.finish({
        id: "missing",
        projectId: "my-app",
        status: "failed",
        errorMessage: "boom",
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)

    await storage.finish({
      id: "run-1",
      projectId: "my-app",
      status: "cancelled",
      errorMessage: "cancelled",
    })

    await expect(
      storage.update({
        id: "run-1",
        projectId: "my-app",
        sourceRowsRead: 1,
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)

    await storage.start({
      id: "run-2",
      projectId: "my-app",
      projectionId: "customer-proj",
      projectionKind: "object",
      datasetId: "canonical.customers",
      datasetVersionId: "ver_2",
    })

    await expect(
      storage.update({
        id: "run-2",
        projectId: "my-app",
        sourceRowsSkipped: -1,
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)
  })
})
