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
    ).rejects.toMatchObject({ code: "storage.conflict", details: { kind: "execution-lost" } })
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
    return storage.projectionRuns
  },
  cleanup: async (projectionRuns) => {
    const owner = contractStorageOwners.get(projectionRuns)
    if (!owner) return
    await owner.dropSchema()
    await owner.close()
  },
})
