import { describe, expect, test } from "bun:test"
import type { ProjectionMaterializationIdentity } from "../materialization/model"
import type { ProjectionRunClaim, ProjectionRunStorage } from "../storage/projection-runs"

export interface ProjectionRunStorageContractSuiteOptions<
  TStorage extends ProjectionRunStorage = ProjectionRunStorage,
> {
  /** Factory that returns an isolated projection-run store for each test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly setup?: (storage: TStorage) => void | Promise<void>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "contract-project"
const objectTarget = { objectTypeId: "Device" } as const

const replacementIdentity = {
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
} as const satisfies ProjectionMaterializationIdentity

const telemetryIdentity = {
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
} as const satisfies ProjectionMaterializationIdentity

/** Runs the single durable, fenced projection-run lifecycle against a provider. */
export function runProjectionRunStorageContractSuite<TStorage extends ProjectionRunStorage>(
  label: string,
  options: ProjectionRunStorageContractSuiteOptions<TStorage>
): void {
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
    test("keeps one run while reclaim rotates its execution", async () => {
      await withStorage(async (storage) => {
        const input = replacementInput("replacement-run")
        const first = await storage.startOrReclaim(input)
        const second = await storage.startOrReclaim(input)

        expect(first.run).toMatchObject({ id: input.id, attempt: 1, status: "running" })
        expect(second.run).toMatchObject({ id: input.id, attempt: 2, status: "running" })
        expect(second.execution.executionToken).not.toBe(first.execution.executionToken)
        expect(second.run).not.toHaveProperty("executionToken")
        expect(await storage.getById({ projectId, id: input.id })).toMatchObject({
          identity: replacementIdentity,
          target: objectTarget,
          progress: { sourceRowsRead: 0, sourceRowsSkipped: 0 },
        })
      })
    })

    test("fences every stale lock, progress, and terminal write", async () => {
      await withStorage(async (storage) => {
        const input = replacementInput("fenced-run")
        const stale = await storage.startOrReclaim(input)
        const current = await storage.startOrReclaim(input)

        await expect(storage.lockForMaterialization(executionInput(stale))).rejects.toThrow(
          "execution token is stale"
        )
        await expect(
          storage.update({
            ...executionInput(stale),
            progress: { sourceRowsRead: 1 },
          })
        ).rejects.toThrow("execution token is stale")
        await expect(
          storage.finish({ ...executionInput(stale), status: "cancelled" })
        ).rejects.toThrow("execution token is stale")

        await expect(
          storage.update({
            ...executionInput(current),
            progress: { sourceRowsRead: 3 },
          })
        ).resolves.toMatchObject({ progress: { sourceRowsRead: 3 } })
      })
    })

    test("rejects immutable identity and target drift", async () => {
      await withStorage(async (storage) => {
        const input = replacementInput("identity-run")
        const claim = await storage.startOrReclaim(input)
        const changedIdentity = { ...replacementIdentity, ownershipHash: "different-ownership" }

        await expect(
          storage.startOrReclaim({ ...input, identity: changedIdentity })
        ).rejects.toThrow("identity does not match")
        await expect(
          storage.startOrReclaim({ ...input, target: { objectTypeId: "OtherDevice" } })
        ).rejects.toThrow("target object types do not match")
        await expect(
          storage.lockForMaterialization({
            ...executionInput(claim),
            identity: changedIdentity,
          })
        ).rejects.toThrow("identity does not match")
      })
    })

    test("keeps physical progress monotone and internally consistent", async () => {
      await withStorage(async (storage) => {
        const claim = await storage.startOrReclaim(replacementInput("progress-run"))
        const execution = executionInput(claim)
        await expect(
          storage.update({
            ...execution,
            progress: { sourceRowsRead: 1, sourceRowsSkipped: 2 },
          })
        ).rejects.toThrow("sourceRowsSkipped must not exceed sourceRowsRead")
        await storage.update({
          ...execution,
          progress: { sourceRowsRead: 5, sourceRowsSkipped: 1 },
        })
        await expect(
          storage.update({ ...execution, progress: { sourceRowsRead: 4 } })
        ).rejects.toThrow("must not decrease")
      })
    })

    test("rejects immutable dataset-version metadata reuse", async () => {
      await withStorage(async (storage) => {
        await storage.startOrReclaim(replacementInput("dataset-metadata-first"))
        await expect(
          storage.startOrReclaim({
            ...replacementInput("dataset-metadata-conflict"),
            identity: {
              ...replacementIdentity,
              datasetVersion: {
                ...replacementIdentity.datasetVersion,
                createdAt: "2026-01-02T00:00:00.000Z",
              },
            },
          })
        ).rejects.toThrow("immutable dataset version id with different metadata")
      })
    })

    test("advances telemetry in contiguous fixed physical batches", async () => {
      await withStorage(async (storage) => {
        const claim = await storage.startOrReclaim({
          id: "telemetry-run",
          projectId,
          identity: telemetryIdentity,
          target: objectTarget,
          fixedBatchSize: 3,
        })
        const execution = executionInput(claim)
        expect(claim.run).toMatchObject({
          telemetryCheckpoint: {
            fixedBatchSize: 3,
            nextBatchOrdinal: 0,
            nextRowOffset: 0,
            inputExhausted: false,
          },
        })
        await expect(
          storage.update({ ...execution, progress: { sourceRowsRead: 1 } })
        ).rejects.toThrow("can only advance with its checkpoint")

        await storage.advanceTelemetryCheckpoint({
          ...execution,
          batchOrdinal: 0,
          batchRowCount: 3,
          batchRowsSkipped: 1,
          inputExhausted: false,
        })
        await expect(
          storage.advanceTelemetryCheckpoint({
            ...execution,
            batchOrdinal: 2,
            batchRowCount: 1,
            batchRowsSkipped: 0,
            inputExhausted: true,
          })
        ).rejects.toThrow("expected batch ordinal 1")
        await expect(
          storage.advanceTelemetryCheckpoint({
            ...execution,
            batchOrdinal: 1,
            batchRowCount: 1,
            batchRowsSkipped: 0,
            inputExhausted: false,
          })
        ).rejects.toThrow("partial non-final batch")

        const exhausted = await storage.advanceTelemetryCheckpoint({
          ...execution,
          batchOrdinal: 1,
          batchRowCount: 2,
          batchRowsSkipped: 1,
          inputExhausted: true,
        })
        expect(exhausted).toMatchObject({
          progress: { sourceRowsRead: 5, sourceRowsSkipped: 2 },
          telemetryCheckpoint: { nextBatchOrdinal: 2, nextRowOffset: 5, inputExhausted: true },
        })
      })
    })

    test("records telemetry EOF atomically with terminal success", async () => {
      await withStorage(async (storage) => {
        const claim = await storage.startOrReclaim({
          id: "empty-telemetry-run",
          projectId,
          identity: telemetryIdentity,
          target: objectTarget,
          fixedBatchSize: 10,
        })
        const finished = await storage.finish({ ...executionInput(claim), status: "succeeded" })
        expect(finished).toMatchObject({
          status: "succeeded",
          progress: { sourceRowsRead: 0 },
          telemetryCheckpoint: { inputExhausted: true },
        })
        await expect(storage.lockForMaterialization(executionInput(claim))).rejects.toThrow(
          "already terminal"
        )
      })
    })

    test("keeps equal run ids isolated by project", async () => {
      await withStorage(async (storage) => {
        await storage.startOrReclaim({ ...replacementInput("shared-id"), projectId: "project-a" })
        await storage.startOrReclaim({ ...replacementInput("shared-id"), projectId: "project-b" })

        expect(await storage.getById({ projectId: "project-a", id: "shared-id" })).not.toBeNull()
        expect(await storage.getById({ projectId: "project-b", id: "shared-id" })).not.toBeNull()
        expect(await storage.getById({ projectId: "project-c", id: "shared-id" })).toBeNull()
      })
    })
  })
}

function replacementInput(id: string) {
  return { id, projectId, identity: replacementIdentity, target: objectTarget } as const
}

function executionInput(claim: ProjectionRunClaim) {
  return {
    id: claim.run.id,
    projectId: claim.run.projectId,
    identity: claim.run.identity,
    executionToken: claim.execution.executionToken,
  }
}
