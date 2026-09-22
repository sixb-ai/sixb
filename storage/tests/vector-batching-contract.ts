import { expect } from "bun:test"
import type { Storage } from "../../packages/core/src/storage"

const now = "2026-01-02T00:00:00.000Z"

export async function seedVectorBatch(storage: Storage, projectId = "batch-project") {
  await storage.transaction(async (tx) => {
    await tx.executions.create({
      projectId,
      id: "batch-execution",
      executor: { type: "request", requestId: "batch" },
      source: { type: "http", requestId: "batch" },
      correlationId: "batch",
      authorizationRef: { type: "disabled" },
    })
    const session = await tx.ontology.materializations.begin({
      commit: {
        projectId,
        id: "batch-commit",
        idempotencyKey: "batch-commit",
        requestHash: "hash",
        executionId: "batch-execution",
        origin: { kind: "runtime", requestId: "batch" },
        ontologyRevision: "test",
        intent: { kind: "edit", mode: "atomic", operationCount: 0 },
        committedAt: now,
      },
      expected: { sources: [], objects: [], links: [], linkScopes: [], points: [] },
    })
    await tx.ontology.vectorIndexing!.schedule({
      projectId,
      session,
      deleted: [],
      availableAt: now,
      requests: ["a", "b"].map((id) => ({
        id,
        batchId: "batch",
        ref: { objectTypeId: "Product", primaryId: id },
        profile: "content",
        configuration: "config",
        sourceFingerprint: id,
        sourceCommitId: "batch-commit",
      })),
    })
    await tx.ontology.materializations.finalize({
      session,
      finalization: {
        sourceActivations: [],
        result: {
          kind: "edit",
          commitId: "batch-commit",
          created: true,
          committedAt: now,
          eventCount: 0,
          outcomes: [],
          changes: { objects: [], links: [] },
        },
      },
    })
  })
}

export async function assertVectorBatchTransitions(storage: Storage) {
  const indexing = storage.ontology.vectorIndexing!
  const projectId = "batch-project"
  const members = () => indexing.getBatch({ projectId, batchId: "batch" })
  expect((await members()).map((work) => work.id)).toEqual(["a", "b"])
  expect(await indexing.getBatch({ projectId: "other", batchId: "batch" })).toEqual([])
  expect(
    (await indexing.listDue({ projectId, now, limit: 10 })).map((work) => work.batchId)
  ).toEqual(["batch", "batch"])
  expect(
    await indexing.getBatchMember({
      projectId,
      batchId: "batch",
      ref: { objectTypeId: "Product", primaryId: "a" },
      profile: "content",
    })
  ).toMatchObject({ id: "a", batchId: "batch" })
  expect(
    await indexing.getBatchMember({
      projectId,
      batchId: "wrong-batch",
      ref: { objectTypeId: "Product", primaryId: "a" },
      profile: "content",
    })
  ).toBeNull()
  const claim = ["a", "b"].map((id) => ({
    id,
    expectedStatus: "pending" as const,
    status: "running" as const,
    availableAt: now,
  }))
  // Removal proof: omit requireAll's storage condition; member a incorrectly becomes running.
  expect(
    await indexing.updateBatch({
      projectId,
      requireAll: true,
      updates: [claim[0]!, { ...claim[1]!, id: "missing" }],
    })
  ).toBe(false)
  expect((await members()).map((work) => work.status)).toEqual(["pending", "pending"])
  const concurrent = await Promise.all([
    indexing.updateBatch({ projectId, requireAll: true, updates: claim }),
    indexing.updateBatch({ projectId, requireAll: true, updates: claim }),
  ])
  expect(concurrent.sort()).toEqual([false, true])
  expect((await members()).map((work) => work.status)).toEqual(["running", "running"])
  await indexing.remove({ projectId, id: "a" })
  expect(
    await indexing.updateBatch({
      projectId,
      updates: ["a", "b"].map((id) => ({
        id,
        expectedStatus: "running",
        status: "ready",
        values: [1, 0],
        availableAt: now,
      })),
    })
  ).toBe(true)
  expect(await members()).toMatchObject([
    { id: "b", batchId: "batch", status: "ready", values: [1, 0] },
  ])
  // Another project's same batch/id must remain untouched.
  expect(
    (await indexing.getBatch({ projectId: "isolated-project", batchId: "batch" })).map(
      (work) => work.status
    )
  ).toEqual(["pending", "pending"])
}
