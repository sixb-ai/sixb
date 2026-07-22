import { describe, expect, test } from "bun:test"
import type { ProjectionMaterializationIdentity } from "../src/materialization/model"
import { isActionMaterializationRunStorage } from "../src/storage/action-runs"
import { InMemoryActionRunStorage } from "../src/storage/action-runs/in-memory"
import { InMemoryStorage } from "../src/storage/index"
import { isProjectionMaterializationRunStorage } from "../src/storage/projection-runs"
import { InMemoryProjectionRunStorage } from "../src/storage/projection-runs/in-memory"

const replacementIdentity: ProjectionMaterializationIdentity = {
  projectionId: "devices",
  projectionKind: "object",
  protocol: "replacement",
  datasetVersion: {
    datasetId: "devices",
    versionId: "v1",
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
    datasetId: "readings",
    versionId: "v1",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  ontologyRevision: "ontology-1",
  projectionRevision: "projection-telemetry-1",
  ownershipHash: "ownership-telemetry-1",
}

describe("projection run materialization ownership", () => {
  test("exposes materialization as an explicit transitional capability", () => {
    expect(isProjectionMaterializationRunStorage(undefined)).toBe(false)
    expect(isProjectionMaterializationRunStorage(null)).toBe(false)
    expect(isProjectionMaterializationRunStorage(new InMemoryProjectionRunStorage())).toBe(true)
    expect(isActionMaterializationRunStorage(undefined)).toBe(false)
    expect(isActionMaterializationRunStorage(null)).toBe(false)
    expect(isActionMaterializationRunStorage(new InMemoryActionRunStorage())).toBe(true)
  })

  test("rotates execution tokens on reclaim and fences stale attempts", async () => {
    const tokens = ["execution-1", "execution-2"]
    const storage = new InMemoryProjectionRunStorage({
      executionToken: () => tokens.shift() ?? "unexpected-token",
    })
    const input = {
      id: "replacement-run",
      projectId: "project",
      identity: replacementIdentity,
      objectTypeId: "Device",
    } as const

    const first = await storage.startOrReclaimMaterialization(input)
    const second = await storage.startOrReclaimMaterialization(input)
    expect(first).toMatchObject({ attempt: 1, executionToken: "execution-1" })
    expect(second).toMatchObject({ attempt: 2, executionToken: "execution-2" })

    await expect(
      storage.updateMaterialization({
        id: input.id,
        projectId: input.projectId,
        identity: replacementIdentity,
        executionToken: "execution-1",
        rowsProcessed: 1,
      })
    ).rejects.toThrow("execution token is stale")
    await expect(
      storage.updateMaterialization({
        id: input.id,
        projectId: input.projectId,
        identity: replacementIdentity,
        executionToken: "execution-2",
        rowsProcessed: 1,
      })
    ).resolves.toMatchObject({ rowsProcessed: 1 })
  })

  test("stores only telemetry resume state and advances it contiguously", async () => {
    const storage = new InMemoryProjectionRunStorage({ executionToken: () => "execution" })
    await storage.startOrReclaimMaterialization({
      id: "telemetry-run",
      projectId: "project",
      identity: telemetryIdentity,
      objectTypeId: "Device",
      fixedBatchSize: 2,
    })

    expect(await storage.getById({ projectId: "project", id: "telemetry-run" })).toMatchObject({
      telemetryCheckpoint: {
        fixedBatchSize: 2,
        nextBatchOrdinal: 0,
        nextRowOffset: 0,
        inputExhausted: false,
      },
    })

    await storage.advanceTelemetryCheckpoint({
      id: "telemetry-run",
      projectId: "project",
      identity: telemetryIdentity,
      executionToken: "execution",
      batchOrdinal: 0,
      batchRowCount: 2,
      inputExhausted: false,
    })
    expect(await storage.getById({ projectId: "project", id: "telemetry-run" })).toMatchObject({
      telemetryCheckpoint: {
        nextBatchOrdinal: 1,
        nextRowOffset: 2,
        inputExhausted: false,
      },
    })

    await expect(
      storage.advanceTelemetryCheckpoint({
        id: "telemetry-run",
        projectId: "project",
        identity: telemetryIdentity,
        executionToken: "execution",
        batchOrdinal: 2,
        batchRowCount: 1,
        inputExhausted: false,
      })
    ).rejects.toThrow("expected batch ordinal 1")

    await expect(
      storage.advanceTelemetryCheckpoint({
        id: "telemetry-run",
        projectId: "project",
        identity: telemetryIdentity,
        executionToken: "execution",
        batchOrdinal: 1,
        batchRowCount: 1,
        inputExhausted: false,
      })
    ).rejects.toThrow("partial non-final batch")
    await expect(
      storage.advanceTelemetryCheckpoint({
        id: "telemetry-run",
        projectId: "project",
        identity: telemetryIdentity,
        executionToken: "execution",
        batchOrdinal: 1,
        batchRowCount: 3,
        inputExhausted: true,
      })
    ).rejects.toThrow("exceeds its fixed size")

    await storage.advanceTelemetryCheckpoint({
      id: "telemetry-run",
      projectId: "project",
      identity: telemetryIdentity,
      executionToken: "execution",
      batchOrdinal: 1,
      batchRowCount: 1,
      inputExhausted: true,
    })
    expect(await storage.getById({ projectId: "project", id: "telemetry-run" })).toMatchObject({
      telemetryCheckpoint: {
        nextBatchOrdinal: 2,
        nextRowOffset: 3,
        inputExhausted: true,
      },
    })

    await expect(
      storage.advanceTelemetryCheckpoint({
        id: "telemetry-run",
        projectId: "project",
        identity: telemetryIdentity,
        executionToken: "execution",
        batchOrdinal: 2,
        batchRowCount: 1,
        inputExhausted: true,
      })
    ).rejects.toThrow("already exhausted")
  })

  test("requires exhausted telemetry state before storage-level success", async () => {
    const storage = new InMemoryProjectionRunStorage({ executionToken: () => "execution" })
    await storage.startOrReclaimMaterialization({
      id: "telemetry-run",
      projectId: "project",
      identity: telemetryIdentity,
      objectTypeId: "Device",
      fixedBatchSize: 10,
    })

    await expect(
      storage.finishMaterialization({
        id: "telemetry-run",
        projectId: "project",
        identity: telemetryIdentity,
        executionToken: "execution",
        status: "succeeded",
      })
    ).rejects.toThrow("before its input is exhausted")

    await storage.completeEmptyTelemetryInput({
      id: "telemetry-run",
      projectId: "project",
      identity: telemetryIdentity,
      executionToken: "execution",
    })
    await expect(
      storage.finishMaterialization({
        id: "telemetry-run",
        projectId: "project",
        identity: telemetryIdentity,
        executionToken: "execution",
        status: "succeeded",
      })
    ).resolves.toMatchObject({ status: "succeeded" })
  })

  test("rejects legacy update and finish for fenced runs", async () => {
    const storage = new InMemoryProjectionRunStorage({ executionToken: () => "execution" })
    await storage.startOrReclaimMaterialization({
      id: "replacement-run",
      projectId: "project",
      identity: replacementIdentity,
      objectTypeId: "Device",
    })

    await expect(
      storage.update({ id: "replacement-run", projectId: "project", rowsProcessed: 1 })
    ).rejects.toThrow("use updateMaterialization()")
    await expect(
      storage.finish({ id: "replacement-run", projectId: "project", status: "succeeded" })
    ).rejects.toThrow("use finishMaterialization()")
  })
})

describe("action run materialization correlation", () => {
  test("requires an existing matching running Action", async () => {
    const storage = new InMemoryActionRunStorage()

    await expect(
      storage.assertMaterializationRun({
        projectId: "project",
        actionId: "sendQuote",
        runId: "action-run",
      })
    ).rejects.toThrow("not found")
    await storage.queue({
      id: "action-run",
      projectId: "project",
      actionId: "sendQuote",
      subject: { kind: "none" },
      params: {},
      idempotencyKey: "action:action-run",
    })
    await expect(
      storage.assertMaterializationRun({
        projectId: "project",
        actionId: "sendQuote",
        runId: "action-run",
      })
    ).rejects.toThrow("status 'queued'")
    await storage.start({ id: "action-run", projectId: "project" })

    await expect(
      storage.assertMaterializationRun({
        projectId: "project",
        actionId: "different-action",
        runId: "action-run",
      })
    ).rejects.toThrow("does not belong")
    await expect(
      storage.assertMaterializationRun({
        projectId: "project",
        actionId: "sendQuote",
        runId: "action-run",
      })
    ).resolves.toBeUndefined()

    await storage.finish({ id: "action-run", projectId: "project", status: "succeeded" })
    await expect(
      storage.assertMaterializationRun({
        projectId: "project",
        actionId: "sendQuote",
        runId: "action-run",
      })
    ).rejects.toThrow("status 'succeeded'")
  })
})

describe("in-memory run root lock", () => {
  test("fences source staging with the current projection execution token", async () => {
    const storage = new InMemoryStorage()
    const start = {
      id: "replacement-run",
      projectId: "project",
      identity: replacementIdentity,
      objectTypeId: "Device",
    } as const
    const first = await storage.projectionRuns.startOrReclaimMaterialization(start)
    if (!first.executionToken) throw new Error("Expected a materialization token.")
    const source = { projectionId: replacementIdentity.projectionId }
    await storage.ontology.sources.beginMaterialization({
      projectId: "project",
      source,
      materializationId: "materialization-1",
      execution: {
        projectionRunId: start.id,
        executionToken: first.executionToken,
      },
      projectionKind: "object",
      protocol: "replacement",
      datasetVersion: replacementIdentity.datasetVersion,
      ontologyRevision: replacementIdentity.ontologyRevision,
      projectionRevision: replacementIdentity.projectionRevision,
      ownershipHash: replacementIdentity.ownershipHash,
      createdAt: "2026-01-01T00:00:01.000Z",
    })

    const reclaimed = await storage.projectionRuns.startOrReclaimMaterialization(start)
    if (!reclaimed.executionToken) throw new Error("Expected a reclaimed token.")
    await expect(
      storage.ontology.sources.stageRows({
        projectId: "project",
        source,
        materializationId: "materialization-1",
        execution: {
          projectionRunId: start.id,
          executionToken: first.executionToken,
        },
        rows: [],
      })
    ).rejects.toThrow("execution token is stale")
    await expect(
      storage.ontology.sources.abandon({
        kind: "reclaim",
        projectId: "project",
        source,
        execution: {
          projectionRunId: start.id,
          executionToken: reclaimed.executionToken,
        },
        abandonedAt: "2026-01-01T00:00:02.000Z",
      })
    ).resolves.toMatchObject({ status: "abandoned", executionToken: null })
  })

  test("serializes projection and action run writes after a failed transaction rollback", async () => {
    const storage = new InMemoryStorage()
    const projection = await storage.projectionRuns.startOrReclaimMaterialization({
      id: "replacement-run",
      projectId: "project",
      identity: replacementIdentity,
      objectTypeId: "Device",
    })
    if (!projection.executionToken) throw new Error("Expected a materialization token.")
    await storage.actionRuns.queue({
      id: "action-run",
      projectId: "project",
      actionId: "sendQuote",
      subject: { kind: "none" },
      params: {},
      idempotencyKey: "action:action-run",
    })
    await storage.actionRuns.start({ id: "action-run", projectId: "project" })

    let releaseTransaction!: () => void
    const transactionBlocked = new Promise<void>((resolve) => {
      releaseTransaction = resolve
    })
    let signalTransactionEntered!: () => void
    const transactionEntered = new Promise<void>((resolve) => {
      signalTransactionEntered = resolve
    })
    const failedTransaction = storage.transaction(async (tx) => {
      if (!isProjectionMaterializationRunStorage(tx.projectionRuns) || !tx.actionRuns) {
        throw new Error("Expected materialization run storage.")
      }
      await tx.projectionRuns.updateMaterialization({
        id: "replacement-run",
        projectId: "project",
        identity: replacementIdentity,
        executionToken: projection.executionToken!,
        rowsProcessed: 99,
      })
      await tx.actionRuns.enterPhase({
        id: "action-run",
        projectId: "project",
        phase: "edits",
      })
      signalTransactionEntered()
      await transactionBlocked
      throw new Error("rollback")
    })
    await transactionEntered

    let projectionFinished = false
    let actionFinished = false
    const projectionWrite = storage.projectionRuns
      .updateMaterialization({
        id: "replacement-run",
        projectId: "project",
        identity: replacementIdentity,
        executionToken: projection.executionToken,
        rowsProcessed: 1,
      })
      .then((record) => {
        projectionFinished = true
        return record
      })
    const actionWrite = storage.actionRuns
      .enterPhase({ id: "action-run", projectId: "project", phase: "effects" })
      .then((record) => {
        actionFinished = true
        return record
      })
    await Promise.resolve()
    expect({ projectionFinished, actionFinished }).toEqual({
      projectionFinished: false,
      actionFinished: false,
    })

    releaseTransaction()
    await expect(failedTransaction).rejects.toThrow("rollback")
    expect(await projectionWrite).toMatchObject({ rowsProcessed: 1 })
    expect(await actionWrite).toMatchObject({ phase: "effects" })
    expect(
      await storage.projectionRuns.getById({ projectId: "project", id: "replacement-run" })
    ).toMatchObject({ rowsProcessed: 1 })
    expect(
      await storage.actionRuns.getById({ projectId: "project", id: "action-run" })
    ).toMatchObject({ phase: "effects" })
  })

  test("does not treat async work inherited from a completed transaction as reentrant", async () => {
    const storage = new InMemoryStorage()
    await storage.actionRuns.queue({
      id: "action-run",
      projectId: "project",
      actionId: "sendQuote",
      subject: { kind: "none" },
      params: {},
      idempotencyKey: "action:action-run",
    })
    await storage.actionRuns.start({ id: "action-run", projectId: "project" })

    let releaseInheritedWrite!: () => void
    const inheritedWriteGate = new Promise<void>((resolve) => {
      releaseInheritedWrite = resolve
    })
    let inheritedWrite!: Promise<unknown>
    let inheritedWriteFinished = false
    await storage.transaction(() => {
      inheritedWrite = inheritedWriteGate
        .then(() =>
          storage.actionRuns.enterPhase({
            id: "action-run",
            projectId: "project",
            phase: "effects",
          })
        )
        .then((record) => {
          inheritedWriteFinished = true
          return record
        })
    })

    let releaseTransaction!: () => void
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransaction = resolve
    })
    let signalTransactionEntered!: () => void
    const transactionEntered = new Promise<void>((resolve) => {
      signalTransactionEntered = resolve
    })
    const failedTransaction = storage.transaction(async (tx) => {
      if (!tx.actionRuns) throw new Error("Expected Action run storage.")
      await tx.actionRuns.enterPhase({
        id: "action-run",
        projectId: "project",
        phase: "edits",
      })
      signalTransactionEntered()
      await transactionGate
      throw new Error("rollback")
    })
    await transactionEntered

    releaseInheritedWrite()
    await Promise.resolve()
    await Promise.resolve()
    expect(inheritedWriteFinished).toBe(false)

    releaseTransaction()
    await expect(failedTransaction).rejects.toThrow("rollback")
    await inheritedWrite
    expect(
      await storage.actionRuns.getById({ projectId: "project", id: "action-run" })
    ).toMatchObject({ phase: "effects" })
  })

  test("allows inherited async work to open a transaction after its parent completed", async () => {
    const storage = new InMemoryStorage()
    let releaseInheritedTransaction!: () => void
    const inheritedTransactionGate = new Promise<void>((resolve) => {
      releaseInheritedTransaction = resolve
    })
    let inheritedTransaction!: Promise<string>

    await storage.transaction(() => {
      inheritedTransaction = inheritedTransactionGate.then(() =>
        storage.transaction(() => "inherited-transaction-completed")
      )
    })

    releaseInheritedTransaction()
    await expect(inheritedTransaction).resolves.toBe("inherited-transaction-completed")
  })
})
