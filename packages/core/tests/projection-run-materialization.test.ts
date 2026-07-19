import { describe, expect, test } from "bun:test"
import { isActionMaterializationRunStorage } from "../src/storage/action-runs"
import { InMemoryActionRunStorage } from "../src/storage/action-runs/in-memory"
import { InMemoryStorage } from "../src/storage/index"
import { isProjectionMaterializationRunStorage } from "../src/storage/projection-runs"
import { InMemoryProjectionRunStorage } from "../src/storage/projection-runs/in-memory"
import type {
  ProjectionRunMaterializationBookkeeping,
  ProjectionRunMaterializationIdentity,
} from "../src/storage/projection-runs/types"

const replacementIdentity: ProjectionRunMaterializationIdentity = {
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

const telemetryIdentity: ProjectionRunMaterializationIdentity = {
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

function replacementBookkeeping(
  executionToken: string,
  overrides: Partial<
    Extract<ProjectionRunMaterializationBookkeeping, { readonly protocol: "replacement" }>
  > = {}
): Extract<ProjectionRunMaterializationBookkeeping, { readonly protocol: "replacement" }> {
  return {
    kind: "projection",
    protocol: "replacement",
    projectionId: replacementIdentity.projectionId,
    projectionKind: "object",
    execution: { projectionRunId: "replacement-run", executionToken },
    datasetVersion: replacementIdentity.datasetVersion,
    ontologyRevision: replacementIdentity.ontologyRevision,
    projectionRevision: replacementIdentity.projectionRevision,
    ownershipHash: replacementIdentity.ownershipHash,
    commitId: "replacement-commit",
    stagedRootCount: 3,
    stagedAssertionCount: 4,
    counts: {
      objectsCreated: 2,
      objectsUpdated: 0,
      objectsDeleted: 1,
      objectsUnchanged: 0,
      linksCreated: 1,
      linksUpdated: 0,
      linksDeleted: 0,
      linksUnchanged: 0,
    },
    ...overrides,
  }
}

function telemetryBookkeeping(input: {
  readonly executionToken: string
  readonly batchOrdinal: number
  readonly commitId: string
  readonly pointsCreated: number
  readonly pointsUpdated?: number
  readonly pointsUnchanged?: number
  readonly latestObjectsChanged?: number
}): Extract<ProjectionRunMaterializationBookkeeping, { readonly protocol: "telemetry" }> {
  const pointsUpdated = input.pointsUpdated ?? 0
  const pointsUnchanged = input.pointsUnchanged ?? 0
  return {
    kind: "projection",
    protocol: "telemetry",
    projectionId: telemetryIdentity.projectionId,
    projectionKind: "telemetry",
    execution: {
      projectionRunId: "telemetry-run",
      executionToken: input.executionToken,
    },
    datasetVersion: telemetryIdentity.datasetVersion,
    ontologyRevision: telemetryIdentity.ontologyRevision,
    projectionRevision: telemetryIdentity.projectionRevision,
    ownershipHash: telemetryIdentity.ownershipHash,
    commitId: input.commitId,
    batchOrdinal: input.batchOrdinal,
    batchInputCount: input.pointsCreated + pointsUpdated + pointsUnchanged,
    batchPointCount: input.pointsCreated + pointsUpdated + pointsUnchanged,
    pointsCreated: input.pointsCreated,
    pointsUpdated,
    pointsUnchanged,
    latestObjectsChanged: input.latestObjectsChanged ?? 0,
  }
}

function replacementReplay(executionToken: string, commitId = "replacement-commit") {
  return {
    kind: "projection",
    protocol: "replacement",
    projectionId: replacementIdentity.projectionId,
    projectionKind: "object",
    execution: { projectionRunId: "replacement-run", executionToken },
    datasetVersion: replacementIdentity.datasetVersion,
    ontologyRevision: replacementIdentity.ontologyRevision,
    projectionRevision: replacementIdentity.projectionRevision,
    ownershipHash: replacementIdentity.ownershipHash,
    commitId,
  } as const
}

function telemetryReplay(executionToken: string, batchOrdinal: number, commitId: string) {
  return {
    kind: "projection",
    protocol: "telemetry",
    projectionId: telemetryIdentity.projectionId,
    projectionKind: "telemetry",
    execution: { projectionRunId: "telemetry-run", executionToken },
    datasetVersion: telemetryIdentity.datasetVersion,
    ontologyRevision: telemetryIdentity.ontologyRevision,
    projectionRevision: telemetryIdentity.projectionRevision,
    ownershipHash: telemetryIdentity.ownershipHash,
    commitId,
    batchOrdinal,
  } as const
}

describe("projection run materialization ownership", () => {
  test("exposes materialization as an explicit strict capability", () => {
    expect(isProjectionMaterializationRunStorage(undefined)).toBe(false)
    expect(isProjectionMaterializationRunStorage(null)).toBe(false)
    expect(isProjectionMaterializationRunStorage(new InMemoryProjectionRunStorage())).toBe(true)
    expect(isActionMaterializationRunStorage(undefined)).toBe(false)
    expect(isActionMaterializationRunStorage(null)).toBe(false)
    expect(isActionMaterializationRunStorage(new InMemoryActionRunStorage())).toBe(true)
  })

  test("rotates an opaque token on reclaim and fences stale or mismatched executions", async () => {
    const tokens = ["execution-1", "execution-2"]
    const storage = new InMemoryProjectionRunStorage({
      executionToken: () => tokens.shift() ?? "unexpected-token",
    })
    const start = {
      id: "replacement-run",
      projectId: "project",
      identity: replacementIdentity,
      objectTypeId: "Device",
    } as const

    const first = await storage.startOrReclaimMaterialization(start)
    expect(first).toMatchObject({ attempt: 1, executionToken: "execution-1", status: "running" })

    const second = await storage.startOrReclaimMaterialization(start)
    expect(second).toMatchObject({ attempt: 2, executionToken: "execution-2" })

    await expect(
      storage.updateMaterialization({
        id: start.id,
        projectId: start.projectId,
        identity: replacementIdentity,
        executionToken: "execution-1",
        rowsProcessed: 1,
      })
    ).rejects.toThrow("execution token is stale")
    await expect(
      storage.assertMaterializationExecution({
        id: start.id,
        projectId: start.projectId,
        identity: { ...replacementIdentity, ontologyRevision: "different" },
        executionToken: "execution-2",
      })
    ).rejects.toThrow("identity does not match")

    await expect(
      storage.updateMaterialization({
        id: start.id,
        projectId: start.projectId,
        identity: replacementIdentity,
        executionToken: "execution-2",
        rowsProcessed: 1,
      })
    ).resolves.toMatchObject({ rowsProcessed: 1 })
  })

  test("rejects invalid runtime materialization kind and protocol values", async () => {
    const storage = new InMemoryProjectionRunStorage({ executionToken: () => "execution" })

    await expect(
      storage.startOrReclaimMaterialization({
        id: "invalid-kind",
        projectId: "project",
        identity: {
          ...replacementIdentity,
          projectionKind: "invalid" as ProjectionRunMaterializationIdentity["projectionKind"],
        },
        objectTypeId: "Device",
      })
    ).rejects.toThrow("projectionKind must be 'object', 'link', or 'telemetry'")
    await expect(
      storage.startOrReclaimMaterialization({
        id: "invalid-protocol",
        projectId: "project",
        identity: {
          ...replacementIdentity,
          protocol: "invalid" as ProjectionRunMaterializationIdentity["protocol"],
        },
        objectTypeId: "Device",
      })
    ).rejects.toThrow("protocol must be 'replacement' or 'telemetry'")

    expect(await storage.getById({ projectId: "project", id: "invalid-kind" })).toBeNull()
    expect(await storage.getById({ projectId: "project", id: "invalid-protocol" })).toBeNull()
  })

  test("rejects legacy update and finish for materialization runs", async () => {
    const storage = new InMemoryProjectionRunStorage({
      executionToken: () => "replacement-token",
    })
    await storage.startOrReclaimMaterialization({
      id: "replacement-run",
      projectId: "project",
      identity: replacementIdentity,
      objectTypeId: "Device",
    })

    await expect(
      storage.update({ id: "replacement-run", projectId: "project", rowsProcessed: 1 })
    ).rejects.toThrow("use updateMaterialization() with the current execution token")
    await expect(
      storage.finish({ id: "replacement-run", projectId: "project", status: "failed" })
    ).rejects.toThrow("use finishMaterialization() with the current execution token")

    await expect(
      storage.assertMaterializationExecution({
        id: "replacement-run",
        projectId: "project",
        identity: replacementIdentity,
        executionToken: "replacement-token",
      })
    ).resolves.toMatchObject({ status: "running", rowsProcessed: 0 })
  })

  test("rejects execution-token ABA before and after snapshot restore", async () => {
    const tokens = ["execution-a", "execution-b", "execution-a"]
    const storage = new InMemoryProjectionRunStorage({
      executionToken: () => tokens.shift() ?? "unexpected-token",
    })
    const start = {
      id: "replacement-run",
      projectId: "project",
      identity: replacementIdentity,
      objectTypeId: "Device",
    } as const

    await expect(storage.startOrReclaimMaterialization(start)).resolves.toMatchObject({
      attempt: 1,
      executionToken: "execution-a",
    })
    await expect(storage.startOrReclaimMaterialization(start)).resolves.toMatchObject({
      attempt: 2,
      executionToken: "execution-b",
    })
    await expect(storage.startOrReclaimMaterialization(start)).rejects.toThrow(
      "execution token was already used"
    )
    const visibleRun = await storage.getById({ projectId: "project", id: start.id })
    expect(visibleRun).toMatchObject({ attempt: 2 })
    expect(visibleRun).not.toHaveProperty("executionToken")

    const restored = new InMemoryProjectionRunStorage({
      executionToken: () => "execution-a",
    })
    restored.restore(storage.snapshot())
    await expect(restored.startOrReclaimMaterialization(start)).rejects.toThrow(
      "execution token was already used"
    )
    const restoredVisibleRun = await restored.getById({ projectId: "project", id: start.id })
    expect(restoredVisibleRun).toMatchObject({ attempt: 2 })
    expect(restoredVisibleRun).not.toHaveProperty("executionToken")
  })

  test("links one replacement commit and rejects missing, divergent, or terminal runs", async () => {
    const storage = new InMemoryProjectionRunStorage({
      executionToken: () => "replacement-token",
    })
    const bookkeeping = replacementBookkeeping("replacement-token")

    await expect(storage.recordMaterializationCommit("project", bookkeeping)).rejects.toThrow(
      "not found"
    )

    await storage.startOrReclaimMaterialization({
      id: "replacement-run",
      projectId: "project",
      identity: replacementIdentity,
      objectTypeId: "Device",
    })
    await expect(
      storage.finishMaterialization({
        id: "replacement-run",
        projectId: "project",
        identity: replacementIdentity,
        executionToken: "replacement-token",
        status: "succeeded",
      })
    ).rejects.toThrow("cannot succeed before")
    await storage.recordMaterializationCommit("project", bookkeeping)
    await storage.recordMaterializationReplay("project", replacementReplay("replacement-token"))

    expect(await storage.getById({ projectId: "project", id: "replacement-run" })).toMatchObject({
      replacementCommitId: "replacement-commit",
      lastMaterializationCommitId: "replacement-commit",
      materializationCommitCount: 1,
      materializationCounters: {
        stagedRootCount: 3,
        stagedAssertionCount: 4,
        objectsCreated: 2,
        objectsDeleted: 1,
        linksCreated: 1,
      },
    })

    await expect(
      storage.recordMaterializationCommit("project", {
        ...bookkeeping,
        commitId: "different-commit",
      })
    ).rejects.toThrow("different materialization commit")
    await expect(
      storage.recordMaterializationReplay(
        "project",
        replacementReplay("replacement-token", "different-commit")
      )
    ).rejects.toThrow("is not linked")
    await expect(
      storage.recordMaterializationCommit("project", {
        ...bookkeeping,
        ontologyRevision: "different",
      })
    ).rejects.toThrow("identity does not match")
    await expect(
      storage.finishMaterialization({
        id: "replacement-run",
        projectId: "project",
        identity: replacementIdentity,
        executionToken: "replacement-token",
        status: "failed",
        errorMessage: "late worker failure",
      })
    ).rejects.toThrow("cannot finish as 'failed' after")

    await storage.finishMaterialization({
      id: "replacement-run",
      projectId: "project",
      identity: replacementIdentity,
      executionToken: "replacement-token",
      status: "succeeded",
    })
    await expect(
      storage.recordMaterializationReplay("project", replacementReplay("replacement-token"))
    ).rejects.toThrow("already terminal")
  })

  test("records contiguous telemetry batches and replays ordinals without double-counting", async () => {
    const tokens = ["telemetry-token-1", "telemetry-token-2"]
    const storage = new InMemoryProjectionRunStorage({
      executionToken: () => tokens.shift() ?? "unexpected-token",
    })
    const start = {
      id: "telemetry-run",
      projectId: "project",
      identity: telemetryIdentity,
      objectTypeId: "Device",
      fixedBatchSize: 2,
    } as const
    await storage.startOrReclaimMaterialization(start)

    await expect(
      storage.recordMaterializationCommit(
        "project",
        telemetryBookkeeping({
          executionToken: "telemetry-token-1",
          batchOrdinal: 0,
          commitId: "telemetry-empty-commit",
          pointsCreated: 0,
        })
      )
    ).rejects.toThrow("batchInputCount must be a positive safe integer")

    const batch0 = telemetryBookkeeping({
      executionToken: "telemetry-token-1",
      batchOrdinal: 0,
      commitId: "telemetry-commit-0",
      pointsCreated: 1,
      pointsUpdated: 1,
      latestObjectsChanged: 1,
    })
    await storage.recordMaterializationCommit("project", batch0)
    await storage.recordMaterializationReplay(
      "project",
      telemetryReplay("telemetry-token-1", 0, "telemetry-commit-0")
    )

    await expect(
      storage.recordMaterializationCommit(
        "project",
        telemetryBookkeeping({
          executionToken: "telemetry-token-1",
          batchOrdinal: 2,
          commitId: "telemetry-commit-2",
          pointsCreated: 1,
        })
      )
    ).rejects.toThrow("expected batch ordinal 1")

    const batch1 = telemetryBookkeeping({
      executionToken: "telemetry-token-1",
      batchOrdinal: 1,
      commitId: "telemetry-commit-1",
      pointsCreated: 1,
      latestObjectsChanged: 1,
    })
    await storage.recordMaterializationCommit("project", batch1)

    const reclaimed = await storage.startOrReclaimMaterialization(start)
    expect(reclaimed).toMatchObject({ attempt: 2, executionToken: "telemetry-token-2" })
    await storage.recordMaterializationReplay(
      "project",
      telemetryReplay("telemetry-token-2", 0, "telemetry-commit-0")
    )
    await expect(
      storage.recordMaterializationReplay(
        "project",
        telemetryReplay("telemetry-token-2", 0, "different-commit")
      )
    ).rejects.toThrow("is not linked")

    const stored = await storage.getById({ projectId: "project", id: "telemetry-run" })
    expect(stored).toMatchObject({
      lastCommittedBatchOrdinal: 1,
      lastMaterializationCommitId: "telemetry-commit-1",
      materializationCommitCount: 2,
      materializationCounters: {
        telemetryPointsCreated: 2,
        telemetryPointsUpdated: 1,
        telemetryPointsUnchanged: 0,
        latestObjectsChanged: 2,
      },
    })

    await expect(
      storage.recordMaterializationCommit(
        "project",
        telemetryBookkeeping({
          executionToken: "telemetry-token-2",
          batchOrdinal: 2,
          commitId: "telemetry-commit-2",
          pointsCreated: 1,
        })
      )
    ).rejects.toThrow("cannot continue after a partial batch")
  })
})

describe("action run materialization correlation", () => {
  test("requires an existing matching running Action and one stable commit", async () => {
    const storage = new InMemoryActionRunStorage()
    const bookkeeping = {
      kind: "action",
      actionId: "sendQuote",
      runId: "action-run",
      commitId: "ontology-commit",
    } as const

    await expect(
      storage.assertMaterializationRun({
        projectId: "project",
        actionId: "sendQuote",
        runId: "action-run",
      })
    ).rejects.toThrow("not found")
    await expect(storage.recordMaterializationCommit("project", bookkeeping)).rejects.toThrow(
      "not found"
    )
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

    await expect(
      storage.recordMaterializationCommit("project", {
        ...bookkeeping,
        actionId: "different-action",
      })
    ).rejects.toThrow("does not belong")

    await storage.recordMaterializationCommit("project", bookkeeping)
    await storage.recordMaterializationReplay("project", bookkeeping)
    expect(await storage.getById({ projectId: "project", id: "action-run" })).toHaveProperty(
      "commitId",
      "ontology-commit"
    )

    await expect(
      storage.recordMaterializationCommit("project", {
        ...bookkeeping,
        commitId: "different-commit",
      })
    ).rejects.toThrow("different ontology commit")
    await storage.finish({ id: "action-run", projectId: "project", status: "succeeded" })
    await expect(
      storage.assertMaterializationRun({
        projectId: "project",
        actionId: "sendQuote",
        runId: "action-run",
      })
    ).rejects.toThrow("status 'succeeded'")
    await expect(storage.recordMaterializationReplay("project", bookkeeping)).rejects.toThrow(
      "status 'succeeded'"
    )
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
