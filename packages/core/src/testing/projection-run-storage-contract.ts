import { describe, expect, test } from "bun:test"
import type { ProjectionMaterializationIdentity } from "../materialization/model"
import type { ProjectionMaterializationRunStorage } from "../storage/projection-runs"

export interface ProjectionRunStorageContractSuiteOptions<
  TStorage extends ProjectionMaterializationRunStorage = ProjectionMaterializationRunStorage,
> {
  /** Factory that returns an isolated projection-run store for each test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  /** Optional provider setup invoked after the store is created. */
  readonly setup?: (storage: TStorage) => void | Promise<void>
  /** Optional provider cleanup invoked after every test, including failed tests. */
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const replacementIdentity: ProjectionMaterializationIdentity = {
  projectionId: "contract.devices",
  projectionKind: "object",
  protocol: "replacement",
  datasetVersion: {
    datasetId: "contract.devices",
    versionId: "version-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  ontologyRevision: "ontology-1",
  projectionRevision: "projection-1",
  ownershipHash: "ownership-1",
}

const telemetryIdentity: ProjectionMaterializationIdentity = {
  projectionId: "contract.temperatures",
  projectionKind: "telemetry",
  protocol: "telemetry",
  datasetVersion: {
    datasetId: "contract.readings",
    versionId: "version-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  ontologyRevision: "ontology-1",
  projectionRevision: "projection-telemetry-1",
  ownershipHash: "ownership-telemetry-1",
}

/**
 * Runs the durable, fenced projection-run lifecycle against a provider.
 *
 * The suite deliberately tests storage mechanics only: stable run identity,
 * immutable provenance, execution-token fencing, physical telemetry checkpoints,
 * and guarded terminal transitions. It does not execute a projection.
 */
export function runProjectionRunStorageContractSuite<
  TStorage extends ProjectionMaterializationRunStorage,
>(label: string, options: ProjectionRunStorageContractSuiteOptions<TStorage>): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await options.setup?.(storage)
      await body(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    test("keeps one stable run while reclaim rotates its token and increments its attempt", async () => {
      await withStorage(async (storage) => {
        const input = {
          id: "replacement-run",
          projectId: "contract-project",
          identity: replacementIdentity,
          objectTypeId: "Device",
        } as const
        const first = await storage.startOrReclaimMaterialization(input)
        const second = await storage.startOrReclaimMaterialization(input)

        expect(first).toMatchObject({ id: input.id, attempt: 1, status: "running" })
        expect(second).toMatchObject({ id: input.id, attempt: 2, status: "running" })
        expect(second.executionToken).not.toBe(first.executionToken)
        expect(await storage.getById({ projectId: input.projectId, id: input.id })).toMatchObject({
          id: input.id,
          attempt: 2,
          projectionId: replacementIdentity.projectionId,
          datasetVersionCreatedAt: replacementIdentity.datasetVersion.createdAt,
          ontologyRevision: replacementIdentity.ontologyRevision,
          projectionRevision: replacementIdentity.projectionRevision,
          ownershipHash: replacementIdentity.ownershipHash,
        })
      })
    })

    test("fences every stale progress and terminal write", async () => {
      await withStorage(async (storage) => {
        const input = {
          id: "fenced-run",
          projectId: "contract-project",
          identity: replacementIdentity,
          objectTypeId: "Device",
        } as const
        const first = await storage.startOrReclaimMaterialization(input)
        const current = await storage.startOrReclaimMaterialization(input)
        const stale = {
          id: input.id,
          projectId: input.projectId,
          identity: replacementIdentity,
          executionToken: first.executionToken,
        }

        await expect(storage.assertMaterializationExecution(stale)).rejects.toThrow(
          "execution token is stale"
        )
        await expect(storage.updateMaterialization({ ...stale, rowsProcessed: 1 })).rejects.toThrow(
          "execution token is stale"
        )
        await expect(
          storage.finishMaterialization({ ...stale, status: "cancelled" })
        ).rejects.toThrow("execution token is stale")

        await expect(
          storage.updateMaterialization({
            ...stale,
            executionToken: current.executionToken,
            rowsProcessed: 3,
          })
        ).resolves.toMatchObject({ rowsProcessed: 3 })
      })
    })

    test("rejects reclaim and writes whose immutable identity or targets drift", async () => {
      await withStorage(async (storage) => {
        const input = {
          id: "identity-run",
          projectId: "contract-project",
          identity: replacementIdentity,
          objectTypeId: "Device",
        } as const
        const claimed = await storage.startOrReclaimMaterialization(input)
        const changedIdentity = {
          ...replacementIdentity,
          ownershipHash: "different-ownership",
        }

        await expect(
          storage.startOrReclaimMaterialization({ ...input, identity: changedIdentity })
        ).rejects.toThrow("identity does not match")
        await expect(
          storage.startOrReclaimMaterialization({ ...input, objectTypeId: "OtherDevice" })
        ).rejects.toThrow("target object types do not match")
        await expect(
          storage.assertMaterializationExecution({
            id: input.id,
            projectId: input.projectId,
            identity: changedIdentity,
            executionToken: claimed.executionToken,
          })
        ).rejects.toThrow("identity does not match")
      })
    })

    test("rejects reused immutable dataset versions with different creation metadata", async () => {
      await withStorage(async (storage) => {
        await storage.startOrReclaimMaterialization({
          id: "dataset-metadata-first",
          projectId: "contract-project",
          identity: replacementIdentity,
          objectTypeId: "Device",
        })
        await expect(
          storage.startOrReclaimMaterialization({
            id: "dataset-metadata-conflict",
            projectId: "contract-project",
            identity: {
              ...replacementIdentity,
              datasetVersion: {
                ...replacementIdentity.datasetVersion,
                createdAt: "2026-01-02T00:00:00.000Z",
              },
            },
            objectTypeId: "Device",
          })
        ).rejects.toThrow("immutable dataset version id with different metadata")
      })
    })

    test("advances telemetry by physical rows in contiguous fixed batches", async () => {
      await withStorage(async (storage) => {
        const claimed = await storage.startOrReclaimMaterialization({
          id: "telemetry-run",
          projectId: "contract-project",
          identity: telemetryIdentity,
          objectTypeId: "Device",
          fixedBatchSize: 3,
        })
        const execution = {
          id: claimed.id,
          projectId: claimed.projectId,
          identity: telemetryIdentity,
          executionToken: claimed.executionToken,
        } as const

        expect(claimed.telemetryCheckpoint).toEqual({
          fixedBatchSize: 3,
          nextBatchOrdinal: 0,
          nextRowOffset: 0,
          inputExhausted: false,
        })
        await storage.advanceTelemetryCheckpoint({
          ...execution,
          batchOrdinal: 0,
          batchRowCount: 3,
          inputExhausted: false,
        })
        await expect(
          storage.advanceTelemetryCheckpoint({
            ...execution,
            batchOrdinal: 2,
            batchRowCount: 1,
            inputExhausted: true,
          })
        ).rejects.toThrow("expected batch ordinal 1")
        await expect(
          storage.advanceTelemetryCheckpoint({
            ...execution,
            batchOrdinal: 1,
            batchRowCount: 1,
            inputExhausted: false,
          })
        ).rejects.toThrow("partial non-final batch")
        await expect(
          storage.advanceTelemetryCheckpoint({
            ...execution,
            batchOrdinal: 1,
            batchRowCount: 4,
            inputExhausted: true,
          })
        ).rejects.toThrow("exceeds its fixed size")

        const exhausted = await storage.advanceTelemetryCheckpoint({
          ...execution,
          batchOrdinal: 1,
          batchRowCount: 2,
          inputExhausted: true,
        })
        expect(exhausted.telemetryCheckpoint).toEqual({
          fixedBatchSize: 3,
          nextBatchOrdinal: 2,
          nextRowOffset: 5,
          inputExhausted: true,
        })
        await expect(
          storage.advanceTelemetryCheckpoint({
            ...execution,
            batchOrdinal: 2,
            batchRowCount: 1,
            inputExhausted: true,
          })
        ).rejects.toThrow("already exhausted")
      })
    })

    test("requires telemetry exhaustion and supports explicit empty input", async () => {
      await withStorage(async (storage) => {
        const claimed = await storage.startOrReclaimMaterialization({
          id: "empty-telemetry-run",
          projectId: "contract-project",
          identity: telemetryIdentity,
          objectTypeId: "Device",
          fixedBatchSize: 10,
        })
        const execution = {
          id: claimed.id,
          projectId: claimed.projectId,
          identity: telemetryIdentity,
          executionToken: claimed.executionToken,
        } as const

        await expect(
          storage.finishMaterialization({ ...execution, status: "succeeded" })
        ).rejects.toThrow("before its input is exhausted")
        await storage.completeEmptyTelemetryInput(execution)
        await expect(storage.completeEmptyTelemetryInput(execution)).rejects.toThrow(
          "after progress"
        )
        const finished = await storage.finishMaterialization({
          ...execution,
          status: "succeeded",
          rowsProcessed: 0,
        })
        expect(finished).toMatchObject({ status: "succeeded", rowsProcessed: 0 })
        await expect(storage.assertMaterializationExecution(execution)).rejects.toThrow(
          "already terminal"
        )
      })
    })

    test("guards terminal transitions and keeps legacy writes away from fenced runs", async () => {
      await withStorage(async (storage) => {
        const claimed = await storage.startOrReclaimMaterialization({
          id: "terminal-run",
          projectId: "contract-project",
          identity: replacementIdentity,
          objectTypeId: "Device",
        })
        const execution = {
          id: claimed.id,
          projectId: claimed.projectId,
          identity: replacementIdentity,
          executionToken: claimed.executionToken,
        } as const

        await expect(
          storage.update({ id: claimed.id, projectId: claimed.projectId, rowsProcessed: 1 })
        ).rejects.toThrow("use updateMaterialization()")
        await expect(
          storage.finish({ id: claimed.id, projectId: claimed.projectId, status: "succeeded" })
        ).rejects.toThrow("use finishMaterialization()")

        await storage.finishMaterialization({
          ...execution,
          status: "failed",
          errorMessage: "invalid input",
        })
        await expect(
          storage.finishMaterialization({ ...execution, status: "cancelled" })
        ).rejects.toThrow("already terminal")
        expect(
          await storage.getById({ projectId: claimed.projectId, id: claimed.id })
        ).toMatchObject({ status: "failed", errorMessage: "invalid input" })
      })
    })

    test("keeps projects isolated when run ids are equal", async () => {
      await withStorage(async (storage) => {
        await storage.startOrReclaimMaterialization({
          id: "shared-id",
          projectId: "project-a",
          identity: replacementIdentity,
          objectTypeId: "Device",
        })
        await storage.startOrReclaimMaterialization({
          id: "shared-id",
          projectId: "project-b",
          identity: replacementIdentity,
          objectTypeId: "Device",
        })

        expect(await storage.getById({ projectId: "project-a", id: "shared-id" })).not.toBeNull()
        expect(await storage.getById({ projectId: "project-b", id: "shared-id" })).not.toBeNull()
        expect(await storage.getById({ projectId: "project-c", id: "shared-id" })).toBeNull()
      })
    })
  })
}
