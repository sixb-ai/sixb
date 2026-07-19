import type { OntologyCommitWrite } from "../storage/ontology"
import {
  attachRunReplay,
  attachRunReplayTransaction,
  replayCommit,
  requireOntologyStorage,
  withSerializationRetry,
} from "./commit-lifecycle"
import { MaterializationValidationError } from "./errors"
import {
  createFixedCommitIdentity,
  createProjectionTelemetryIdempotencyKey,
  createRuntimeTelemetryIdempotencyKey,
} from "./identity"
import type { MaterializerContext } from "./materializer-context"
import { normalizeTelemetryAppend } from "./normalize"
import { telemetryOwnershipKey } from "./refs"
import { planTelemetryAppend } from "./telemetry-plan"
import type { OntologyMaterializationOrigin, TelemetryAppend, TelemetryCommitResult } from "./types"
import { validateTelemetryPoint } from "./validate-effective"
import { drainStagedEvents, drainStagedWork } from "./work-executor"

export async function appendTelemetry(
  context: MaterializerContext,
  raw: TelemetryAppend
): Promise<TelemetryCommitResult> {
  const input = normalizeTelemetryAppend(raw)
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
  const idempotencyKey =
    input.source.kind === "runtime"
      ? createRuntimeTelemetryIdempotencyKey(input.source.requestId)
      : createProjectionTelemetryIdempotencyKey({
          source: input.source.projection,
          datasetVersion: input.source.datasetVersion,
          batchOrdinal: input.source.batchOrdinal,
        })
  const callerIntent =
    input.source.kind === "runtime"
      ? input
      : {
          ...input,
          source: {
            kind: "projection" as const,
            projection: input.source.projection,
            datasetVersion: input.source.datasetVersion,
            batchOrdinal: input.source.batchOrdinal,
          },
        }
  const identity = createFixedCommitIdentity({
    projectId: context.projectId,
    idempotencyKey,
    normalizedCallerIntent: callerIntent,
    now: context.clock(),
  })
  const replay = await replayCommit<TelemetryCommitResult>(context, identity)
  if (replay) {
    if (input.source.kind === "projection") {
      await attachRunReplayTransaction(
        context,
        "projection",
        input.source.projectionRunId,
        identity.commitId
      )
    }
    return replay
  }

  return withSerializationRetry(context, async () =>
    context.storage.transaction(
      async (txBase) => {
        const tx = requireOntologyStorage(txBase)
        const replayInTransaction = await replayCommit<TelemetryCommitResult>(context, identity, tx)
        if (replayInTransaction) {
          if (input.source.kind === "projection") {
            await attachRunReplay(
              tx,
              context.projectId,
              "projection",
              input.source.projectionRunId,
              identity.commitId
            )
          }
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
                  projectionRunId: input.source.projectionRunId,
                  datasetId: input.source.datasetVersion.datasetId,
                  datasetVersionId: input.source.datasetVersion.versionId,
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
          ontologyRevision: context.projectionRegistry.ontologyRevision,
          ...(resolvedProjection
            ? {
                projectionRevision: resolvedProjection.projectionRevision,
                ownershipHash: resolvedProjection.ownershipHash,
              }
            : {}),
          intent: {
            kind: "telemetry",
            pointCount: input.points.length,
            ...(input.source.kind === "projection"
              ? { batchOrdinal: input.source.batchOrdinal }
              : {}),
          },
          committedAt: identity.committedAt,
        }
        const session = await tx.ontology.materializations.begin({
          commit,
          expected: {
            ontologyRevision: context.projectionRegistry.ontologyRevision,
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
                    runId: input.source.projectionRunId,
                    datasetVersion: input.source.datasetVersion,
                    projectionRevision: resolvedProjection.projectionRevision,
                    commitId: identity.commitId,
                    batchOrdinal: input.source.batchOrdinal,
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
