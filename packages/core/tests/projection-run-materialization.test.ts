import { describe, expect, test } from "bun:test"
import type { ProjectionMaterializationIdentity } from "../src/materialization/model"
import type { ExecutionStorage } from "../src/storage/executions/types"
import { InMemoryStorage } from "../src/storage/in-memory/index"
import type {
  ProjectionRunStorage,
  StartOrReclaimProjectionRunInput,
} from "../src/storage/projection-runs/types"
import { createTestActionRunRecord } from "../src/testing"

function actionRunInput(id: string) {
  return {
    id,
    projectId: "project",
    actionId: "sendQuote",
    subject: { kind: "none" as const },
    params: {},
    idempotencyKey: `action:${id}`,
  }
}

const replacementIdentity = {
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
} as const satisfies ProjectionMaterializationIdentity

const telemetryIdentity = {
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
} as const satisfies ProjectionMaterializationIdentity

// The shared projection-run storage contract (projection-runs.test.ts) proves reclaim rotation,
// stale-token fencing, contiguous checkpoint advance and explicit EOF. These are the in-memory
// telemetry checkpoint guards it does not reach.
test("telemetry runs move progress only through bounded, unexhausted checkpoints", async () => {
  const storage = new InMemoryStorage()
  const input = {
    id: "telemetry-run",
    projectId: "project",
    identity: telemetryIdentity,
    target: { objectTypeId: "Device" },
    fixedBatchSize: 2,
  } as const
  await admitProjectionRun(storage.executions, storage.projectionRuns, input)
  const { execution } = await storage.projectionRuns.startOrReclaim(input)
  const batch = {
    id: "telemetry-run",
    projectId: "project",
    identity: telemetryIdentity,
    executionToken: execution.executionToken,
    batchRowsSkipped: 0,
  }

  await expect(
    storage.projectionRuns.finish({
      ...batch,
      protocol: "telemetry",
      status: "failed",
      progress: { sourceRowsSkipped: 1 },
    })
  ).rejects.toThrow("can only advance with its checkpoint")
  await expect(
    storage.projectionRuns.advanceTelemetryCheckpoint({
      ...batch,
      batchOrdinal: 0,
      batchRowCount: 3,
      inputExhausted: true,
    })
  ).rejects.toThrow("exceeds its fixed size")

  await storage.projectionRuns.advanceTelemetryCheckpoint({
    ...batch,
    batchOrdinal: 0,
    batchRowCount: 1,
    inputExhausted: true,
  })
  await expect(
    storage.projectionRuns.advanceTelemetryCheckpoint({
      ...batch,
      batchOrdinal: 1,
      batchRowCount: 1,
      inputExhausted: true,
    })
  ).rejects.toThrow("already exhausted")
})

async function admitProjectionRun(
  executions: ExecutionStorage,
  projectionRuns: ProjectionRunStorage,
  input: StartOrReclaimProjectionRunInput
): Promise<void> {
  const executionId = `execution:${input.id}`
  await executions.create({
    id: executionId,
    projectId: input.projectId,
    executor: { type: "primitive", kind: "projection", runId: input.id },
    source: {
      type: "datasetVersion",
      datasetId: input.identity.datasetVersion.datasetId,
      versionId: input.identity.datasetVersion.versionId,
    },
    correlationId: input.id,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "projection", id: input.identity.projectionId, runId: input.id },
    },
  })
  await projectionRuns.queue({ ...input, executionId })
}

describe("in-memory run root lock", () => {
  test("fences source staging with the current projection execution token", async () => {
    const storage = new InMemoryStorage()
    const start = {
      id: "replacement-run",
      projectId: "project",
      identity: replacementIdentity,
      target: { objectTypeId: "Device" },
    } as const
    await admitProjectionRun(storage.executions, storage.projectionRuns, start)
    const first = await storage.projectionRuns.startOrReclaim(start)
    const source = { projectionId: replacementIdentity.projectionId }
    await storage.ontology.sources.beginMaterialization({
      projectId: "project",
      source,
      materializationId: "materialization-1",
      execution: first.execution,
      projectionKind: "object",
      protocol: "replacement",
      datasetVersion: replacementIdentity.datasetVersion,
      ontologyRevision: replacementIdentity.ontologyRevision,
      projectionRevision: replacementIdentity.projectionRevision,
      ownershipHash: replacementIdentity.ownershipHash,
      createdAt: "2026-01-01T00:00:01.000Z",
    })

    const reclaimed = await storage.projectionRuns.startOrReclaim(start)
    await expect(
      storage.ontology.sources.stageRows({
        projectId: "project",
        source,
        materializationId: "materialization-1",
        execution: first.execution,
        rows: [],
      })
    ).rejects.toThrow("execution token is stale")
    await expect(
      storage.ontology.sources.abandon({
        kind: "run",
        projectId: "project",
        source,
        execution: reclaimed.execution,
        abandonedAt: "2026-01-01T00:00:02.000Z",
      })
    ).resolves.toMatchObject({ status: "abandoned", executionToken: null })
  })

  test("serializes projection and action run writes after a failed transaction rollback", async () => {
    const storage = new InMemoryStorage()
    const projectionInput = {
      id: "replacement-run",
      projectId: "project",
      identity: replacementIdentity,
      target: { objectTypeId: "Device" },
    } as const
    await admitProjectionRun(storage.executions, storage.projectionRuns, projectionInput)
    const projection = await storage.projectionRuns.startOrReclaim(projectionInput)
    const actionRun = await createTestActionRunRecord(
      storage.executions,
      actionRunInput("action-run")
    )

    let releaseTransaction!: () => void
    const transactionBlocked = new Promise<void>((resolve) => {
      releaseTransaction = resolve
    })
    let signalTransactionEntered!: () => void
    const transactionEntered = new Promise<void>((resolve) => {
      signalTransactionEntered = resolve
    })
    const failedTransaction = storage.transaction(async (tx) => {
      if (!tx.projectionRuns || !tx.actionRuns) {
        throw new Error("Expected materialization run storage.")
      }
      await tx.projectionRuns.update({
        id: "replacement-run",
        projectId: "project",
        identity: replacementIdentity,
        executionToken: projection.execution.executionToken,
        progress: { sourceRowsRead: 99 },
      })
      await tx.actionRuns.record(actionRun)
      signalTransactionEntered()
      await transactionBlocked
      throw new Error("rollback")
    })
    await transactionEntered

    let projectionFinished = false
    let actionFinished = false
    const projectionWrite = storage.projectionRuns
      .update({
        id: "replacement-run",
        projectId: "project",
        identity: replacementIdentity,
        executionToken: projection.execution.executionToken,
        progress: { sourceRowsRead: 1 },
      })
      .then((record) => {
        projectionFinished = true
        return record
      })
    const actionWrite = storage.actionRuns
      .record({ ...actionRun, phase: "writeback" })
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
    expect(await projectionWrite).toMatchObject({ progress: { sourceRowsRead: 1 } })
    expect(await actionWrite).toMatchObject({ phase: "writeback" })
    expect(
      await storage.projectionRuns.getById({ projectId: "project", id: "replacement-run" })
    ).toMatchObject({ progress: { sourceRowsRead: 1 } })
    expect(
      await storage.actionRuns.getById({ projectId: "project", id: "action-run" })
    ).toMatchObject({ phase: "writeback" })
  })

  test("does not treat async work inherited from a completed transaction as reentrant", async () => {
    const storage = new InMemoryStorage()
    const inheritedRun = await createTestActionRunRecord(
      storage.executions,
      actionRunInput("action-run")
    )
    const rolledBackRun = await createTestActionRunRecord(
      storage.executions,
      actionRunInput("rolled-back-run")
    )

    let releaseInheritedWrite!: () => void
    const inheritedWriteGate = new Promise<void>((resolve) => {
      releaseInheritedWrite = resolve
    })
    let inheritedWrite!: Promise<unknown>
    let inheritedWriteFinished = false
    await storage.transaction(() => {
      inheritedWrite = inheritedWriteGate
        .then(() => storage.actionRuns.record(inheritedRun))
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
      await tx.actionRuns.record(rolledBackRun)
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
    ).toMatchObject({ status: "succeeded" })
    expect(
      await storage.actionRuns.getById({ projectId: "project", id: "rolled-back-run" })
    ).toBeNull()
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
