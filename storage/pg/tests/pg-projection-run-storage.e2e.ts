import { expect, test } from "bun:test"
import type { ProjectionMaterializationIdentity } from "@sixb/core/storage"
import { runProjectionRunStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

const replacementIdentity = {
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
} as const satisfies ProjectionMaterializationIdentity

test("PgProjectionRunStorage serializes concurrent reclaims", async () => {
  const { storage } = await createTestStorage()
  try {
    const input = {
      id: "stable-run",
      projectId: "my-app",
      identity: replacementIdentity,
      target: { objectTypeId: "Device" },
    } as const
    const executionId = "execution:stable-run"
    await storage.executions.create({
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
    await storage.projectionRuns.queue({ ...input, executionId })
    const claims = await Promise.all([
      storage.projectionRuns.startOrReclaim(input),
      storage.projectionRuns.startOrReclaim(input),
    ])
    claims.sort((left, right) => left.run.attempt - right.run.attempt)
    const [stale, current] = claims

    expect(claims.map((claim) => claim.run.attempt)).toEqual([1, 2])
    expect(current.execution.executionToken).not.toBe(stale.execution.executionToken)
    await expect(
      storage.projectionRuns.lockForMaterialization({
        id: input.id,
        projectId: input.projectId,
        identity: replacementIdentity,
        executionToken: stale.execution.executionToken,
      })
    ).rejects.toMatchObject({ name: "ProjectionRunError", kind: "execution-lost" })
  } finally {
    await storage.dropSchema()
    await storage.close()
  }
})

const contractStorageOwners = new WeakMap<PostgresStorage["projectionRuns"], PostgresStorage>()

runProjectionRunStorageContractSuite("PgProjectionRunStorage contract", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    contractStorageOwners.set(storage.projectionRuns, storage)
    return { projectionRuns: storage.projectionRuns, executions: storage.executions }
  },
  cleanup: async (context) => {
    const owner = contractStorageOwners.get(context.projectionRuns)
    if (!owner) return
    await owner.dropSchema()
    await owner.close()
  },
})
