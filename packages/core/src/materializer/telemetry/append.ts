import type { TelemetryOntologyCommitIntent } from "../../materialization/commits"
import { MaterializationValidationError } from "../../materialization/errors"
import type {
  OntologyMaterializationOrigin,
  TelemetryAppend,
  TelemetryCommitResult,
} from "../../materialization/model"
import { telemetryOwnershipKey } from "../../materialization/refs"
import type {
  ProjectionRunMaterializationIdentity,
  ProjectionRunMaterializationReplay,
} from "../../storage"
import { isProjectionMaterializationRunStorage } from "../../storage"
import type { OntologyCommitWrite } from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import { validateTelemetryPoint } from "../effective/validate"
import {
  attachRunReplay,
  attachRunReplayTransaction,
  replayCommit,
  requireOntologyStorage,
  withSerializationRetry,
} from "../execution/commit-lifecycle"
import { assertProjectionRunTargets } from "../execution/run-correlation"
import { drainStagedEvents, drainStagedWork } from "../execution/work-executor"
import {
  createProjectionTelemetryIdempotencyKey,
  createRuntimeTelemetryIdempotencyKey,
  createTimedCommitIdentity,
} from "../shared/identity"
import { normalizeTelemetryAppend } from "../shared/normalize"
import { planTelemetryAppend } from "./plan"

export async function appendTelemetry(
  context: MaterializerContext,
  raw: TelemetryAppend
): Promise<TelemetryCommitResult> {
  const rawInputPointCount = raw.points.length
  const input = normalizeTelemetryAppend(raw)
  const inputPointCount =
    input.source.kind === "projection" ? rawInputPointCount : input.points.length
  if (input.source.kind === "projection" && inputPointCount === 0) {
    throw new MaterializationValidationError(
      "Projection telemetry batches must contain at least one physical input point; an empty dataset produces no batch commit."
    )
  }
  const resolvedProjection =
    input.source.kind === "projection"
      ? context.projectionRegistry.resolveTelemetry(input.source.projection.projectionId)
      : null
  if (
    resolvedProjection &&
    input.source.kind === "projection" &&
    resolvedProjection.datasetId !== input.source.datasetVersion.datasetId
  ) {
    throw new MaterializationValidationError(
      `Telemetry projection '${resolvedProjection.projectionId}' requires dataset '${resolvedProjection.datasetId}'.`
    )
  }
  for (const point of input.points) validateTelemetryPoint(context.ontology, point)
  if (resolvedProjection) {
    const ownedSeries = new Set(
      resolvedProjection.ownership.telemetry.map(({ objectTypeId, propertyId }) =>
        telemetryOwnershipKey(objectTypeId, propertyId)
      )
    )
    for (const point of input.points) {
      const scope = telemetryOwnershipKey(point.series.object.objectTypeId, point.series.propertyId)
      if (!ownedSeries.has(scope)) {
        throw new MaterializationValidationError(
          `Telemetry projection '${resolvedProjection.projectionId}' does not own series '${point.series.object.objectTypeId}.${point.series.propertyId}'.`
        )
      }
    }
  }

  const ontologyRevision = context.projectionRegistry.ontologyRevision
  const runIdentity: ProjectionRunMaterializationIdentity | null =
    input.source.kind === "projection" && resolvedProjection
      ? {
          projectionId: resolvedProjection.projectionId,
          projectionKind: "telemetry",
          protocol: "telemetry",
          datasetVersion: input.source.datasetVersion,
          ontologyRevision,
          projectionRevision: resolvedProjection.projectionRevision,
          ownershipHash: resolvedProjection.ownershipHash,
        }
      : null
  const projectionRuns = context.storage.projectionRuns
  if (runIdentity && !isProjectionMaterializationRunStorage(projectionRuns)) {
    throw new MaterializationValidationError(
      "Storage does not provide projection run capabilities required by telemetry projection."
    )
  }

  const idempotencyKey =
    input.source.kind === "runtime"
      ? createRuntimeTelemetryIdempotencyKey(input.source.requestId)
      : createProjectionTelemetryIdempotencyKey({
          source: input.source.projection,
          projectionKind: "telemetry",
          datasetVersion: input.source.datasetVersion,
          ontologyRevision,
          projectionRevision: resolvedProjection!.projectionRevision,
          ownershipHash: resolvedProjection!.ownershipHash,
          batchOrdinal: input.source.batchOrdinal,
        })
  // Execution ownership is transient: a reclaimed delivery must retain the same request hash.
  const callerIntent =
    input.source.kind === "runtime"
      ? input
      : {
          source: {
            kind: "projection" as const,
            projection: input.source.projection,
            datasetVersion: input.source.datasetVersion,
            batchOrdinal: input.source.batchOrdinal,
          },
          ...(input.actor !== undefined ? { actor: input.actor } : {}),
          inputPointCount,
          points: input.points,
        }
  const identity = createTimedCommitIdentity({
    projectId: context.projectId,
    idempotencyKey,
    normalizedCallerIntent: callerIntent,
    now: context.clock(),
  })
  const replayProof: ProjectionRunMaterializationReplay | null =
    input.source.kind === "projection" && resolvedProjection
      ? {
          kind: "projection",
          protocol: "telemetry",
          projectionId: resolvedProjection.projectionId,
          projectionKind: "telemetry",
          execution: input.source.execution,
          datasetVersion: input.source.datasetVersion,
          ontologyRevision,
          projectionRevision: resolvedProjection.projectionRevision,
          ownershipHash: resolvedProjection.ownershipHash,
          commitId: identity.commitId,
          batchOrdinal: input.source.batchOrdinal,
        }
      : null

  if (input.source.kind === "projection" && runIdentity) {
    if (!isProjectionMaterializationRunStorage(projectionRuns)) {
      throw new MaterializationValidationError(
        "Storage does not provide projection run capabilities required by telemetry projection."
      )
    }
    const assertedRun = await projectionRuns.assertMaterializationExecution({
      id: input.source.execution.projectionRunId,
      projectId: context.projectId,
      executionToken: input.source.execution.executionToken,
      identity: runIdentity,
    })
    assertProjectionRunTargets(assertedRun, resolvedProjection!)
  }
  const replay = await replayCommit<TelemetryCommitResult>(context, identity)
  if (replay) {
    if (replayProof) await attachRunReplayTransaction(context, replayProof)
    return replay
  }

  return withSerializationRetry(context, async () =>
    context.storage.transaction(
      async (txBase) => {
        const tx = requireOntologyStorage(txBase)
        if (input.source.kind === "projection" && runIdentity) {
          if (!isProjectionMaterializationRunStorage(tx.projectionRuns)) {
            throw new MaterializationValidationError(
              "Storage transaction does not provide projection run capabilities."
            )
          }
          const assertedRunInTransaction = await tx.projectionRuns.assertMaterializationExecution({
            id: input.source.execution.projectionRunId,
            projectId: context.projectId,
            executionToken: input.source.execution.executionToken,
            identity: runIdentity,
          })
          assertProjectionRunTargets(assertedRunInTransaction, resolvedProjection!)
        }
        const replayInTransaction = await replayCommit<TelemetryCommitResult>(context, identity, tx)
        if (replayInTransaction) {
          if (replayProof) await attachRunReplay(tx, context.projectId, replayProof)
          return replayInTransaction
        }
        const origin: OntologyMaterializationOrigin = {
          kind: "telemetry",
          source:
            input.source.kind === "runtime"
              ? input.source
              : {
                  kind: "projection",
                  projectionId: input.source.projection.projectionId,
                  projectionRunId: input.source.execution.projectionRunId,
                  datasetId: input.source.datasetVersion.datasetId,
                  datasetVersionId: input.source.datasetVersion.versionId,
                  batchOrdinal: input.source.batchOrdinal,
                },
        }
        const commitIntent: TelemetryOntologyCommitIntent =
          input.source.kind === "runtime"
            ? {
                kind: "telemetry",
                pointCount: input.points.length,
                inputPointCount,
                source: { kind: "runtime" },
              }
            : {
                kind: "telemetry",
                pointCount: input.points.length,
                inputPointCount,
                source: {
                  kind: "projection",
                  projection: input.source.projection,
                  datasetVersion: input.source.datasetVersion,
                  batchOrdinal: input.source.batchOrdinal,
                },
              }
        const commit: OntologyCommitWrite = {
          projectId: context.projectId,
          id: identity.commitId,
          idempotencyKey: identity.idempotencyKey,
          requestHash: identity.requestHash,
          origin,
          ...(input.actor !== undefined ? { actor: input.actor } : {}),
          ontologyRevision,
          ...(resolvedProjection
            ? {
                projectionRevision: resolvedProjection.projectionRevision,
                ownershipHash: resolvedProjection.ownershipHash,
              }
            : {}),
          intent: commitIntent,
          committedAt: identity.committedAt,
        }
        const session = await tx.ontology.materializations.begin({
          commit,
          expected: {
            sources: [],
            objects: [],
            links: [],
            linkScopes: [],
            points: [],
          },
        })
        const { pointsCreated, pointsUpdated, pointsUnchanged, latestObjectsChanged } =
          await planTelemetryAppend(
            context,
            tx.ontology.materializations,
            session,
            input,
            identity,
            origin
          )
        await drainStagedWork(context, tx.ontology.materializations, session)
        const eventCount = await drainStagedEvents(
          context,
          tx.ontology.materializations,
          session,
          identity
        )
        const result: TelemetryCommitResult = {
          kind: "telemetry",
          commitId: identity.commitId,
          created: true,
          eventCount,
          pointsCreated,
          pointsUpdated,
          pointsUnchanged,
          latestObjectsChanged,
        }
        const applied = await tx.ontology.materializations.finalize({
          session,
          finalization: {
            sourceActivations: [],
            result,
            ...(input.source.kind === "projection" && resolvedProjection
              ? {
                  bookkeeping: {
                    kind: "projection" as const,
                    protocol: "telemetry" as const,
                    projectionId: resolvedProjection.projectionId,
                    projectionKind: "telemetry" as const,
                    execution: input.source.execution,
                    datasetVersion: input.source.datasetVersion,
                    ontologyRevision,
                    projectionRevision: resolvedProjection.projectionRevision,
                    ownershipHash: resolvedProjection.ownershipHash,
                    commitId: identity.commitId,
                    batchOrdinal: input.source.batchOrdinal,
                    batchInputCount: inputPointCount,
                    batchPointCount: input.points.length,
                    pointsCreated,
                    pointsUpdated,
                    pointsUnchanged,
                    latestObjectsChanged,
                  },
                }
              : {}),
          },
        })
        return applied.commit.result as TelemetryCommitResult
      },
      { isolation: "serializable" }
    )
  )
}
