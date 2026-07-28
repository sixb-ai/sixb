import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ProjectionMaterializationIdentity } from "@sixb/core/storage"
import { ProjectionRunError } from "@sixb/core/storage"
import { runProjectionRunStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

const replacementIdentity: ProjectionMaterializationIdentity = {
  projectionId: "devices",
  projectionKind: "object",
  protocol: "replacement",
  datasetVersion: {
    datasetId: "canonical.devices",
    versionId: "version-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  ontologyRevision: "ontology-1",
  projectionRevision: "projection-1",
  ownershipHash: "ownership-1",
}

const telemetryIdentity: ProjectionMaterializationIdentity = {
  projectionId: "temperatures",
  projectionKind: "telemetry",
  protocol: "telemetry",
  datasetVersion: {
    datasetId: "canonical.readings",
    versionId: "version-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  ontologyRevision: "ontology-1",
  projectionRevision: "projection-telemetry-1",
  ownershipHash: "ownership-telemetry-1",
}

describe("PgProjectionRunStorage", () => {
  let storage: PostgresStorage

  beforeEach(async () => {
    ;({ storage } = await createTestStorage())
  })

  afterEach(async () => {
    await storage.dropSchema()
    await storage.close()
  })

  test("atomically reclaims one stable materialization run and fences stale attempts", async () => {
    const input = {
      id: "stable-run",
      projectId: "my-app",
      identity: replacementIdentity,
      objectTypeId: "Device",
    } as const

    const claims = await Promise.all([
      storage.projectionRuns.startOrReclaimMaterialization(input),
      storage.projectionRuns.startOrReclaimMaterialization(input),
    ])
    claims.sort((left, right) => left.attempt - right.attempt)
    const [first, current] = claims

    expect(claims.map((claim) => claim.attempt)).toEqual([1, 2])
    expect(current.executionToken).not.toBe(first.executionToken)
    expect(
      await storage.projectionRuns.getById({ projectId: input.projectId, id: input.id })
    ).toMatchObject({
      id: input.id,
      attempt: 2,
      projectionId: replacementIdentity.projectionId,
      projectionKind: replacementIdentity.projectionKind,
      materializationProtocol: replacementIdentity.protocol,
      datasetId: replacementIdentity.datasetVersion.datasetId,
      datasetVersionId: replacementIdentity.datasetVersion.versionId,
      datasetVersionCreatedAt: replacementIdentity.datasetVersion.createdAt,
      ontologyRevision: replacementIdentity.ontologyRevision,
      projectionRevision: replacementIdentity.projectionRevision,
      ownershipHash: replacementIdentity.ownershipHash,
      objectTypeId: "Device",
    })

    const stale = {
      id: input.id,
      projectId: input.projectId,
      identity: replacementIdentity,
      executionToken: first.executionToken,
    } as const
    for (const operation of [
      () => storage.projectionRuns.assertMaterializationExecution(stale),
      () => storage.projectionRuns.updateMaterialization({ ...stale, sourceRowsRead: 1 }),
      () => storage.projectionRuns.finishMaterialization({ ...stale, status: "cancelled" }),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        name: "ProjectionRunError",
        kind: "execution-lost",
      })
    }

    await expect(
      storage.projectionRuns.updateMaterialization({
        ...stale,
        executionToken: current.executionToken,
        sourceRowsRead: 3,
      })
    ).resolves.toMatchObject({ sourceRowsRead: 3 })
    await expect(
      storage.projectionRuns.startOrReclaimMaterialization({
        ...input,
        identity: { ...replacementIdentity, ownershipHash: "changed" },
      })
    ).rejects.toThrow("identity does not match")
    await expect(
      storage.projectionRuns.startOrReclaimMaterialization({ ...input, objectTypeId: "Other" })
    ).rejects.toThrow("target object types do not match")
    await expect(
      storage.projectionRuns.update({
        id: input.id,
        projectId: input.projectId,
        sourceRowsRead: 4,
      })
    ).rejects.toThrow("use updateMaterialization()")
  })

  test("persists and guards telemetry fixed-batch checkpoints and EOF", async () => {
    const first = await storage.projectionRuns.startOrReclaimMaterialization({
      id: "telemetry-run",
      projectId: "my-app",
      identity: telemetryIdentity,
      objectTypeId: "Device",
      fixedBatchSize: 3,
    })
    const current = await storage.projectionRuns.startOrReclaimMaterialization({
      id: "telemetry-run",
      projectId: "my-app",
      identity: telemetryIdentity,
      objectTypeId: "Device",
      fixedBatchSize: 3,
    })
    const execution = {
      id: current.id,
      projectId: current.projectId,
      identity: telemetryIdentity,
      executionToken: current.executionToken,
    } as const

    await expect(
      storage.projectionRuns.advanceTelemetryCheckpoint({
        ...execution,
        executionToken: first.executionToken,
        batchOrdinal: 0,
        batchRowCount: 3,
        batchRowsSkipped: 0,
        inputExhausted: false,
      })
    ).rejects.toMatchObject({ kind: "execution-lost" })
    await expect(
      storage.projectionRuns.completeTelemetryInput({
        ...execution,
        executionToken: first.executionToken,
      })
    ).rejects.toMatchObject({ kind: "execution-lost" })
    await expect(
      storage.projectionRuns.finishMaterialization({ ...execution, status: "succeeded" })
    ).rejects.toThrow("before its input is exhausted")

    await storage.projectionRuns.advanceTelemetryCheckpoint({
      ...execution,
      batchOrdinal: 0,
      batchRowCount: 3,
      batchRowsSkipped: 0,
      inputExhausted: false,
    })
    await expect(
      storage.projectionRuns.advanceTelemetryCheckpoint({
        ...execution,
        batchOrdinal: 1,
        batchRowCount: 1,
        batchRowsSkipped: 0,
        inputExhausted: false,
      })
    ).rejects.toThrow("partial non-final batch")
    const exhausted = await storage.projectionRuns.advanceTelemetryCheckpoint({
      ...execution,
      batchOrdinal: 1,
      batchRowCount: 2,
      batchRowsSkipped: 0,
      inputExhausted: true,
    })
    expect(exhausted.telemetryCheckpoint).toEqual({
      fixedBatchSize: 3,
      nextBatchOrdinal: 2,
      nextRowOffset: 5,
      inputExhausted: true,
    })
    await expect(storage.projectionRuns.completeTelemetryInput(execution)).resolves.toMatchObject({
      telemetryCheckpoint: { inputExhausted: true },
    })
    await expect(
      storage.projectionRuns.finishMaterialization({ ...execution, status: "succeeded" })
    ).resolves.toMatchObject({ status: "succeeded" })

    const empty = await storage.projectionRuns.startOrReclaimMaterialization({
      id: "empty-telemetry-run",
      projectId: "my-app",
      identity: telemetryIdentity,
      objectTypeId: "Device",
      fixedBatchSize: 3,
    })
    const emptyExecution = {
      id: empty.id,
      projectId: empty.projectId,
      identity: telemetryIdentity,
      executionToken: empty.executionToken,
    } as const
    await storage.projectionRuns.completeTelemetryInput(emptyExecution)
    await expect(
      storage.projectionRuns.completeTelemetryInput(emptyExecution)
    ).resolves.toMatchObject({ telemetryCheckpoint: { inputExhausted: true } })
    await expect(
      storage.projectionRuns.finishMaterialization({
        ...emptyExecution,
        status: "succeeded",
        sourceRowsRead: 0,
      })
    ).resolves.toMatchObject({ status: "succeeded", sourceRowsRead: 0 })
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
      sourceRowsRead: 10,
      sourceRowsSkipped: 1,
    })

    const finished = await storage.projectionRuns.finish({
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
      sourceRowsRead: 3,
      sourceRowsSkipped: 1,
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
    expect(failed?.sourceRowsRead).toBe(3)
    expect(failed?.sourceRowsSkipped).toBe(1)
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
        sourceRowsRead: 1,
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
        sourceRowsSkipped: -1,
      })
    ).rejects.toBeInstanceOf(ProjectionRunError)
  })
})

const contractStorageOwners = new WeakMap<PostgresStorage["projectionRuns"], PostgresStorage>()

runProjectionRunStorageContractSuite("PgProjectionRunStorage materialization contract", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    contractStorageOwners.set(storage.projectionRuns, storage)
    return storage.projectionRuns
  },
  cleanup: async (projectionRuns) => {
    const owner = contractStorageOwners.get(projectionRuns)
    if (!owner) return
    await owner.dropSchema()
    await owner.close()
  },
})
