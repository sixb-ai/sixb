import { describe, expect, test } from "bun:test"
import type { SixbFailure } from "../errors/types"
import type { ProjectionMaterializationIdentity } from "../materialization/model"
import type { ExecutionStorage } from "../storage/executions"
import type {
  ProjectionRunClaim,
  ProjectionRunFailureCode,
  ProjectionRunStorage,
  QueueProjectionRunInput,
  StartOrReclaimProjectionRunInput,
} from "../storage/projection-runs"

export interface ProjectionRunStorageContractContext<
  TStorage extends ProjectionRunStorage = ProjectionRunStorage,
> {
  readonly projectionRuns: TStorage
  readonly executions: ExecutionStorage
}

export interface ProjectionRunStorageContractSuiteOptions<
  TStorage extends ProjectionRunStorage = ProjectionRunStorage,
> {
  /** Factory that returns one isolated execution + projection-run store for each test. */
  readonly createStorage: () =>
    | ProjectionRunStorageContractContext<TStorage>
    | Promise<ProjectionRunStorageContractContext<TStorage>>
  readonly setup?: (context: ProjectionRunStorageContractContext<TStorage>) => void | Promise<void>
  readonly cleanup?: (
    context: ProjectionRunStorageContractContext<TStorage>
  ) => void | Promise<void>
}

const projectId = "contract-project"
const objectTarget = { objectTypeId: "Device" } as const

const failure = {
  code: "internal.unexpected",
  message: "Projection failed",
  retryable: false,
  at: "2026-06-01T12:00:00.000Z",
  details: { projectionId: "contract.devices", runId: "failed-run" },
} as const satisfies SixbFailure<ProjectionRunFailureCode>

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
  const withStorage = async (
    body: (context: ProjectionRunStorageContractContext<TStorage>) => Promise<void>
  ): Promise<void> => {
    const context = await options.createStorage()
    try {
      await options.setup?.(context)
      await body(context)
    } finally {
      await options.cleanup?.(context)
    }
  }

  describe(label, () => {
    test("admits a queued run only after its durable execution exists", async () => {
      await withStorage(async (context) => {
        const input = replacementInput("queued-run")
        await expect(
          context.projectionRuns.queue({
            ...input,
            executionId: "missing-execution",
          })
        ).rejects.toThrow()

        const wrongSourceExecutionId = "execution:wrong-source"
        await context.executions.create({
          id: wrongSourceExecutionId,
          projectId: input.projectId,
          executor: { type: "primitive", kind: "projection", runId: input.id },
          source: { type: "event", eventId: "wrong-source" },
          correlationId: input.id,
          authorizationRef: {
            type: "trustedPrimitive",
            primitive: { kind: "projection", id: input.identity.projectionId, runId: input.id },
          },
        })
        await expect(
          context.projectionRuns.queue({
            ...input,
            executionId: wrongSourceExecutionId,
          })
        ).rejects.toThrow("does not authorize Projection run")

        const admission = await admitProjectionRun(context, input)
        await expect(
          context.projectionRuns.getById({ projectId: input.projectId, id: input.id })
        ).resolves.toMatchObject({
          id: input.id,
          executionId: admission.executionId,
          status: "queued",
          attempt: 0,
        })
      })
    })

    test("requeues the same admission after an enqueue failure", async () => {
      await withStorage(async (context) => {
        const input = replacementInput("enqueue-retry-run")
        const admission = await admitProjectionRun(context, input)
        await expect(
          context.projectionRuns.failEnqueue({
            id: input.id,
            projectId: input.projectId,
            error: {
              code: "queue.enqueue_failed",
              message: "queue unavailable",
              retryable: true,
              at: "2026-06-01T12:00:00.000Z",
              details: { projectionId: input.identity.projectionId, runId: input.id },
            },
          })
        ).resolves.toMatchObject({
          status: "failed",
          error: { code: "queue.enqueue_failed", message: "queue unavailable" },
        })

        await expect(context.projectionRuns.queue(admission)).resolves.toMatchObject({
          executionId: admission.executionId,
          status: "queued",
          attempt: 0,
        })
      })
    })

    test("keeps one run while reclaim rotates its execution", async () => {
      await withStorage(async (context) => {
        const storage = context.projectionRuns
        const input = replacementInput("replacement-run")
        await admitProjectionRun(context, input)
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
      await withStorage(async (context) => {
        const storage = context.projectionRuns
        const input = replacementInput("fenced-run")
        await admitProjectionRun(context, input)
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
          storage.finish({
            ...executionInput(stale),
            protocol: "replacement",
            status: "cancelled",
          })
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
      await withStorage(async (context) => {
        const storage = context.projectionRuns
        const input = replacementInput("identity-run")
        await admitProjectionRun(context, input)
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
      await withStorage(async (context) => {
        const storage = context.projectionRuns
        await admitProjectionRun(context, replacementInput("progress-run"))
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
      await withStorage(async (context) => {
        await admitProjectionRun(context, replacementInput("dataset-metadata-first"))
        await expect(
          admitProjectionRun(context, {
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
      await withStorage(async (context) => {
        const storage = context.projectionRuns
        const input = {
          id: "telemetry-run",
          projectId,
          identity: telemetryIdentity,
          target: objectTarget,
          fixedBatchSize: 3,
        } as const
        await admitProjectionRun(context, input)
        const claim = await storage.startOrReclaim(input)
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

    test("keeps a missing target until the batch it blocks commits", async () => {
      await withStorage(async (context) => {
        const storage = context.projectionRuns
        const input = {
          id: "telemetry-missing-target-run",
          projectId,
          identity: telemetryIdentity,
          target: objectTarget,
          fixedBatchSize: 2,
        } as const
        await admitProjectionRun(context, input)
        const claim = await storage.startOrReclaim(input)
        const execution = executionInput(claim)
        const firstSeenAt = new Date("2026-06-01T12:00:00.000Z")
        const missingTarget = {
          objectTypeId: "Device",
          objectId: "missing-device",
          batchOrdinal: 0,
          firstSeenAt,
        }

        const waiting = await storage.recordMissingTarget({ ...execution, missingTarget })
        expect(waiting.missingTarget).toEqual(missingTarget)
        expect(
          (await storage.getById({ projectId, id: "telemetry-missing-target-run" }))?.missingTarget
        ).toEqual(missingTarget)

        // A wait anchored to a batch the run has already passed would outlive the progress that
        // resolved it, so it is refused rather than stored.
        await expect(
          storage.recordMissingTarget({
            ...execution,
            missingTarget: { ...missingTarget, batchOrdinal: 1 },
          })
        ).rejects.toThrow("cannot wait on batch 1")

        // A run can only wait on the object type it writes: nothing else can appear in its
        // telemetry. Refused here so an adapter never has to rely on its own CHECK for it.
        await expect(
          storage.recordMissingTarget({
            ...execution,
            missingTarget: { ...missingTarget, objectTypeId: "Building" },
          })
        ).rejects.toThrow("cannot wait on 'Building'")

        // The whole wait or none of it. A half-written one reads as waiting since the epoch, or
        // waiting for nothing, and both decide a run's fate.
        for (const partial of [
          { objectId: "" },
          { objectTypeId: "" },
          { firstSeenAt: new Date(Number.NaN) },
        ]) {
          await expect(
            storage.recordMissingTarget({
              ...execution,
              missingTarget: { ...missingTarget, ...partial },
            })
          ).rejects.toThrow()
        }

        // The write is last-wins; keeping the original start is the worker's rule, which only
        // records when the object or the batch changes. An adapter that merged instead would
        // make that rule unenforceable.
        const rerecorded = await storage.recordMissingTarget({
          ...execution,
          missingTarget: { ...missingTarget, firstSeenAt: new Date("2026-06-01T12:01:00.000Z") },
        })
        expect(rerecorded.missingTarget?.firstSeenAt).toEqual(new Date("2026-06-01T12:01:00.000Z"))

        const advanced = await storage.advanceTelemetryCheckpoint({
          ...execution,
          batchOrdinal: 0,
          batchRowCount: 2,
          batchRowsSkipped: 0,
          inputExhausted: true,
        })
        expect(advanced.missingTarget).toBeUndefined()
      })
    })

    test("requires and records explicit telemetry EOF with terminal success", async () => {
      await withStorage(async (context) => {
        const storage = context.projectionRuns
        const input = {
          id: "empty-telemetry-run",
          projectId,
          identity: telemetryIdentity,
          target: objectTarget,
          fixedBatchSize: 10,
        } as const
        await admitProjectionRun(context, input)
        const claim = await storage.startOrReclaim(input)

        await expect(
          storage.finish({
            ...executionInput(claim),
            protocol: "telemetry",
            status: "succeeded",
          } as Parameters<ProjectionRunStorage["finish"]>[0])
        ).rejects.toThrow("cannot succeed before input exhaustion")
        await expect(storage.getById({ projectId, id: claim.run.id })).resolves.toMatchObject({
          status: "running",
          telemetryCheckpoint: { inputExhausted: false },
        })

        const finished = await storage.finish({
          ...executionInput(claim),
          protocol: "telemetry",
          status: "succeeded",
          inputExhausted: true,
        })
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

    test("validates, detaches, and persists scoped failures", async () => {
      await withStorage(async (context) => {
        const storage = context.projectionRuns
        await admitProjectionRun(context, replacementInput("failed-run"))
        const claim = await storage.startOrReclaim(replacementInput("failed-run"))
        const finished = await storage.finish({
          ...executionInput(claim),
          protocol: "replacement",
          status: "failed",
          finishedAt: new Date(failure.at),
          error: failure,
        })

        expect(finished).toMatchObject({
          status: "failed",
          finishedAt: new Date(failure.at),
          error: failure,
        })
        expect(finished.error).not.toBe(failure)
        await expect(storage.getById({ projectId, id: "failed-run" })).resolves.toMatchObject({
          error: failure,
        })

        await admitProjectionRun(context, replacementInput("invalid-failure-run"))
        const invalid = await storage.startOrReclaim(replacementInput("invalid-failure-run"))
        await expect(
          storage.finish({
            ...executionInput(invalid),
            protocol: "replacement",
            status: "failed",
            error: { ...failure, code: "dataset.not_found" } as never,
          })
        ).rejects.toThrow("code is not allowed by this failure contract")
      })
    })

    test("keeps equal run ids isolated by project", async () => {
      await withStorage(async (context) => {
        const storage = context.projectionRuns
        const projectA = { ...replacementInput("shared-id"), projectId: "project-a" } as const
        const projectB = { ...replacementInput("shared-id"), projectId: "project-b" } as const
        await admitProjectionRun(context, projectA)
        await admitProjectionRun(context, projectB)
        await storage.startOrReclaim(projectA)
        await storage.startOrReclaim(projectB)

        expect(await storage.getById({ projectId: "project-a", id: "shared-id" })).not.toBeNull()
        expect(await storage.getById({ projectId: "project-b", id: "shared-id" })).not.toBeNull()
        expect(await storage.getById({ projectId: "project-c", id: "shared-id" })).toBeNull()
      })
    })
  })
}

async function admitProjectionRun<TStorage extends ProjectionRunStorage>(
  context: ProjectionRunStorageContractContext<TStorage>,
  input: StartOrReclaimProjectionRunInput
): Promise<QueueProjectionRunInput> {
  const executionId = `execution:${input.projectId}:${input.id}`
  await context.executions.create({
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
  const admission = {
    ...input,
    executionId,
    queuedAt: new Date("2026-01-01T00:00:01.000Z"),
  } satisfies QueueProjectionRunInput
  await context.projectionRuns.queue(admission)
  return admission
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
