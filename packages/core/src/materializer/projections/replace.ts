import {
  MaterializationCancellationError,
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type {
  OntologyMaterializationOrigin,
  PinnedDatasetVersion,
  ProjectionCommitResult,
  ProjectionSourceReplacement,
} from "../../materialization/model"
import type {
  ProjectionRunMaterializationIdentity,
  ProjectionRunMaterializationReplay,
} from "../../storage"
import { isProjectionMaterializationRunStorage } from "../../storage"
import type { OntologyCommitWrite, OntologyStorage } from "../../storage/ontology"
import type { MaterializerContext } from "../context"
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
  createCommitIdentity,
  createProjectionIdempotencyKey,
  timestampCommitIdentity,
} from "../shared/identity"
import {
  normalizePinnedDatasetVersion,
  normalizeProjectionExecution,
  normalizeProjectionSourceRef,
} from "../shared/normalize"
import { createProjectionEntryValidator } from "./entry-validator"
import { planProjectionReplacement } from "./replacement-plan"
import {
  bestEffort,
  stageProjectionMaterialization,
  throwIfAborted,
} from "./source-materialization"

export async function replaceProjection(
  context: MaterializerContext,
  raw: ProjectionSourceReplacement
): Promise<ProjectionCommitResult> {
  const source = normalizeProjectionSourceRef(raw.source)
  const datasetVersion = normalizePinnedDatasetVersion(raw.datasetVersion)
  const execution = normalizeProjectionExecution(raw.execution)
  const resolved = context.projectionRegistry.resolveSource(source.projectionId)
  if (datasetVersion.datasetId !== resolved.datasetId) {
    throw new MaterializationValidationError(
      `Projection '${resolved.projectionId}' requires dataset '${resolved.datasetId}'.`
    )
  }
  const projectionRuns = context.storage.projectionRuns
  if (!isProjectionMaterializationRunStorage(projectionRuns)) {
    throw new MaterializationValidationError(
      "Storage does not provide projection run capabilities required by source replacement."
    )
  }

  const projectionKind =
    resolved.definition._tag === "ObjectProjectionDefinition" ? "object" : "link"
  const runIdentity: ProjectionRunMaterializationIdentity = {
    projectionId: resolved.projectionId,
    projectionKind,
    protocol: "replacement",
    datasetVersion,
    ontologyRevision: context.projectionRegistry.ontologyRevision,
    projectionRevision: resolved.projectionRevision,
    ownershipHash: resolved.ownershipHash,
  }
  const idempotencyKey = createProjectionIdempotencyKey({
    source,
    projectionKind,
    datasetVersion,
    ontologyRevision: runIdentity.ontologyRevision,
    projectionRevision: runIdentity.projectionRevision,
    ownershipHash: runIdentity.ownershipHash,
  })
  const identity = createCommitIdentity({
    projectId: context.projectId,
    idempotencyKey,
    normalizedCallerIntent: { source, datasetVersion },
  })
  const replayProof: ProjectionRunMaterializationReplay = {
    kind: "projection",
    protocol: "replacement",
    projectionId: resolved.projectionId,
    projectionKind,
    execution,
    datasetVersion,
    ontologyRevision: runIdentity.ontologyRevision,
    projectionRevision: runIdentity.projectionRevision,
    ownershipHash: runIdentity.ownershipHash,
    commitId: identity.commitId,
  }

  const assertedRun = await projectionRuns.assertMaterializationExecution({
    id: execution.projectionRunId,
    projectId: context.projectId,
    executionToken: execution.executionToken,
    identity: runIdentity,
  })
  assertProjectionRunTargets(assertedRun, resolved)
  const replay = await replayCommit<ProjectionCommitResult>(context, identity)
  if (replay) {
    await attachRunReplayTransaction(context, replayProof)
    return replay
  }

  // Reconcile the previous attempt before any new precondition can fail. Otherwise a redelivery
  // fenced by a newer active watermark could leave its old staging/ready candidate nonterminal.
  await context.storage.ontology.sources.abandon({
    kind: "reclaim",
    projectId: context.projectId,
    source,
    execution,
    abandonedAt: context.clock().toISOString(),
  })
  const active = await context.storage.ontology.sources.getActive({
    projectId: context.projectId,
    source,
  })
  validateProjectionWatermark(active, datasetVersion)
  const expectedSource = {
    source,
    activeMaterializationId: active?.materializationId ?? null,
    lastCommitId: active?.lastCommitId ?? null,
  }
  const materializationId = context.materializationId()
  const createdAt = context.clock().toISOString()

  try {
    const staged = await stageProjectionMaterialization(context, {
      source,
      materializationId,
      execution,
      projectionKind,
      datasetVersion,
      projectionRevision: resolved.projectionRevision,
      ownershipHash: resolved.ownershipHash,
      createdAt,
      entries: raw.entries,
      validateEntry: createProjectionEntryValidator(context.ontology, resolved),
      ...(raw.signal !== undefined ? { signal: raw.signal } : {}),
    })

    // Commit time is fixed only once ingress is ready, then retained across serialization retries.
    const timedIdentity = timestampCommitIdentity(identity, context.clock())
    return await withSerializationRetry(context, async () =>
      context.storage.transaction(
        async (txBase) => {
          const tx = requireOntologyStorage(txBase)
          if (!isProjectionMaterializationRunStorage(tx.projectionRuns)) {
            throw new MaterializationValidationError(
              "Storage transaction does not provide projection run capabilities."
            )
          }
          const assertedRunInTransaction = await tx.projectionRuns.assertMaterializationExecution({
            id: execution.projectionRunId,
            projectId: context.projectId,
            executionToken: execution.executionToken,
            identity: runIdentity,
          })
          assertProjectionRunTargets(assertedRunInTransaction, resolved)
          const replayInTransaction = await replayCommit<ProjectionCommitResult>(
            context,
            identity,
            tx
          )
          if (replayInTransaction) {
            await attachRunReplay(tx, context.projectId, replayProof)
            return replayInTransaction
          }

          const origin: OntologyMaterializationOrigin = {
            kind: "projection",
            projectionId: resolved.projectionId,
            projectionRunId: execution.projectionRunId,
            datasetId: datasetVersion.datasetId,
            datasetVersionId: datasetVersion.versionId,
          }
          const commit: OntologyCommitWrite = {
            projectId: context.projectId,
            id: timedIdentity.commitId,
            idempotencyKey: timedIdentity.idempotencyKey,
            requestHash: timedIdentity.requestHash,
            origin,
            ontologyRevision: runIdentity.ontologyRevision,
            projectionRevision: runIdentity.projectionRevision,
            ownershipHash: runIdentity.ownershipHash,
            intent: { kind: "projection", source, datasetVersion },
            committedAt: timedIdentity.committedAt,
          }
          throwIfAborted(raw.signal)
          const session = await tx.ontology.materializations.begin({
            commit,
            expected: {
              sources: [expectedSource],
              objects: [],
              links: [],
              linkScopes: [],
              points: [],
            },
          })
          const counts = await planProjectionReplacement(
            context,
            tx.ontology.materializations,
            session,
            {
              source,
              materializationId,
              projectionKind,
              identity: timedIdentity,
              origin,
              ...(raw.signal !== undefined ? { signal: raw.signal } : {}),
            }
          )
          await drainStagedWork(context, tx.ontology.materializations, session, raw.signal)
          const eventCount = await drainStagedEvents(
            context,
            tx.ontology.materializations,
            session,
            timedIdentity,
            raw.signal
          )
          const result: ProjectionCommitResult = {
            kind: "projection",
            commitId: timedIdentity.commitId,
            created: true,
            eventCount,
            counts,
          }
          throwIfAborted(raw.signal)
          const applied = await tx.ontology.materializations.finalize({
            session,
            finalization: {
              sourceActivations: [
                {
                  source,
                  materializationId,
                  execution,
                  projectionKind,
                  protocol: "replacement",
                  datasetVersion,
                  projectionRevision: runIdentity.projectionRevision,
                  ownershipHash: runIdentity.ownershipHash,
                  ontologyRevision: runIdentity.ontologyRevision,
                  expected: expectedSource,
                  lastCommitId: timedIdentity.commitId,
                  updatedAt: timedIdentity.committedAt,
                },
              ],
              result,
              bookkeeping: {
                kind: "projection",
                protocol: "replacement",
                projectionId: resolved.projectionId,
                projectionKind,
                execution,
                datasetVersion,
                ontologyRevision: runIdentity.ontologyRevision,
                projectionRevision: runIdentity.projectionRevision,
                ownershipHash: runIdentity.ownershipHash,
                commitId: timedIdentity.commitId,
                stagedRootCount: staged.rootCount,
                stagedAssertionCount: staged.assertionCount,
                counts,
              },
            },
          })
          return applied.commit.result as ProjectionCommitResult
        },
        { isolation: "serializable" }
      )
    )
  } catch (error) {
    if (
      error instanceof MaterializationValidationError ||
      error instanceof MaterializationCancellationError ||
      (error instanceof MaterializationConflictError && error.kind === "run-correlation")
    ) {
      await bestEffort(() =>
        context.storage.ontology.sources.abandon({
          kind: "candidate",
          projectId: context.projectId,
          source,
          materializationId,
          execution,
          abandonedAt: context.clock().toISOString(),
        })
      )
    }
    throw error
  }
}

function validateProjectionWatermark(
  active: Awaited<ReturnType<OntologyStorage["sources"]["getActive"]>>,
  next: PinnedDatasetVersion
): void {
  if (!active) return
  if (active.datasetVersion.datasetId !== next.datasetId) {
    throw new MaterializationConflictError(
      "projection-fence",
      "Projection replacement dataset does not match the active source dataset."
    )
  }
  if (
    active.datasetVersion.versionId === next.versionId &&
    active.datasetVersion.createdAt !== next.createdAt
  ) {
    throw new MaterializationConflictError(
      "projection-fence",
      "Projection replacement reused an immutable dataset version id with different metadata."
    )
  }
  const currentAt = Date.parse(active.datasetVersion.createdAt)
  const nextAt = Date.parse(next.createdAt)
  if (nextAt < currentAt) {
    throw new MaterializationConflictError(
      "projection-fence",
      "Projection replacement dataset version is older than the active watermark."
    )
  }
  if (nextAt === currentAt && active.datasetVersion.versionId !== next.versionId) {
    throw new MaterializationConflictError(
      "projection-fence",
      "Projection replacement dataset watermark is ambiguous."
    )
  }
}
