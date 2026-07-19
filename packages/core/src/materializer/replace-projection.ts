import type { OntologyCommitWrite, OntologyStorage } from "../storage/ontology"
import {
  attachRunReplay,
  attachRunReplayTransaction,
  replayCommit,
  requireOntologyStorage,
  withSerializationRetry,
} from "./commit-lifecycle"
import { MaterializationConflictError, MaterializationValidationError } from "./errors"
import { createFixedCommitIdentity, createProjectionIdempotencyKey } from "./identity"
import type { MaterializerContext } from "./materializer-context"
import {
  normalizePinnedDatasetVersion,
  normalizeProjectionRunId,
  normalizeProjectionSourceRef,
} from "./normalize"
import { createProjectionEntryValidator } from "./projection-entry-validator"
import {
  cleanupInactiveProjectionGenerations,
  discardProjectionGeneration,
  stageProjectionGeneration,
  throwIfAborted,
} from "./projection-generation"
import { planProjectionReplacement } from "./projection-replacement-plan"
import type {
  OntologyMaterializationOrigin,
  PinnedDatasetVersion,
  ProjectionCommitResult,
  ProjectionSourceReplacement,
} from "./types"
import { drainStagedEvents, drainStagedWork } from "./work-executor"

export async function replaceProjection(
  context: MaterializerContext,
  raw: ProjectionSourceReplacement
): Promise<ProjectionCommitResult> {
  const resolved = context.projectionRegistry.resolveSource(raw.source.projectionId)
  if (raw.datasetVersion.datasetId !== resolved.datasetId) {
    throw new MaterializationValidationError(
      `Projection '${resolved.projectionId}' requires dataset '${resolved.datasetId}'.`
    )
  }
  const source = normalizeProjectionSourceRef(raw.source)
  const datasetVersion = normalizePinnedDatasetVersion(raw.datasetVersion)
  const projectionRunId = normalizeProjectionRunId(raw.projectionRunId)
  const idempotencyKey = createProjectionIdempotencyKey(
    source,
    datasetVersion,
    resolved.projectionRevision
  )
  const identity = createFixedCommitIdentity({
    projectId: context.projectId,
    idempotencyKey,
    normalizedCallerIntent: { source, datasetVersion },
    now: context.clock(),
  })
  await cleanupInactiveProjectionGenerations(context.storage.ontology, {
    projectId: context.projectId,
    committedAt: identity.committedAt,
    limit: context.batching.sourceStageRows,
  })
  const replay = await replayCommit<ProjectionCommitResult>(context, identity)
  if (replay) {
    await attachRunReplayTransaction(context, "projection", projectionRunId, identity.commitId)
    return replay
  }

  const active = await context.storage.ontology.sources.getActive({
    projectId: context.projectId,
    source,
  })
  validateProjectionWatermark(active, datasetVersion)
  const expectedSource = {
    source,
    activeGenerationId: active?.activeGenerationId ?? null,
    lastCommitId: active?.lastCommitId ?? null,
  }
  const generationId = context.generationId()
  const stagedAt = identity.committedAt
  let stagedRootCount = 0
  let stagedAssertionCount = 0
  try {
    const stagedGeneration = await stageProjectionGeneration(context, {
      source,
      generationId,
      stagedAt,
      entries: raw.entries,
      validateEntry: createProjectionEntryValidator(context.ontology, resolved),
      ...(raw.signal !== undefined ? { signal: raw.signal } : {}),
    })
    stagedRootCount = stagedGeneration.rootCount
    stagedAssertionCount = stagedGeneration.assertionCount

    const result = await withSerializationRetry(context, async () =>
      context.storage.transaction(
        async (txBase) => {
          const tx = requireOntologyStorage(txBase)
          const replayInTransaction = await replayCommit<ProjectionCommitResult>(
            context,
            identity,
            tx
          )
          if (replayInTransaction) {
            await attachRunReplay(
              tx,
              context.projectId,
              "projection",
              projectionRunId,
              identity.commitId
            )
            return replayInTransaction
          }
          const origin: OntologyMaterializationOrigin = {
            kind: "projection",
            projectionId: resolved.projectionId,
            projectionRunId: projectionRunId,
            datasetId: datasetVersion.datasetId,
            datasetVersionId: datasetVersion.versionId,
          }
          const commit: OntologyCommitWrite = {
            projectId: context.projectId,
            id: identity.commitId,
            idempotencyKey: identity.idempotencyKey,
            requestHash: identity.requestHash,
            origin,
            ontologyRevision: context.projectionRegistry.ontologyRevision,
            projectionRevision: resolved.projectionRevision,
            ownershipHash: resolved.ownershipHash,
            intent: {
              kind: "projection",
              source: source,
              datasetVersion: datasetVersion,
            },
            committedAt: identity.committedAt,
          }
          throwIfAborted(raw.signal)
          const session = await tx.ontology.materializations.begin({
            commit,
            expected: {
              ontologyRevision: context.projectionRegistry.ontologyRevision,
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
              generationId,
              identity,
              origin,
              ...(raw.signal !== undefined ? { signal: raw.signal } : {}),
            }
          )
          await drainStagedWork(context, tx.ontology.materializations, session, raw.signal)
          const eventCount = await drainStagedEvents(
            context,
            tx.ontology.materializations,
            session,
            identity,
            raw.signal
          )
          const result: ProjectionCommitResult = {
            kind: "projection",
            commitId: identity.commitId,
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
                  source: source,
                  generationId,
                  datasetVersion: datasetVersion,
                  projectionRevision: resolved.projectionRevision,
                  ownershipHash: resolved.ownershipHash,
                  ontologyRevision: context.projectionRegistry.ontologyRevision,
                  expected: expectedSource,
                  lastCommitId: identity.commitId,
                  updatedAt: identity.committedAt,
                },
              ],
              result,
              bookkeeping: {
                kind: "projection",
                protocol: "replacement",
                projectionId: resolved.projectionId,
                runId: projectionRunId,
                datasetVersion: datasetVersion,
                projectionRevision: resolved.projectionRevision,
                commitId: identity.commitId,
                stagedRootCount,
                stagedAssertionCount,
                counts,
              },
            },
          })
          throwIfAborted(raw.signal)
          return applied.commit.result as ProjectionCommitResult
        },
        { isolation: "serializable" }
      )
    )
    const activeAfterCommit = await context.storage.ontology.sources.getActive({
      projectId: context.projectId,
      source: source,
    })
    if (activeAfterCommit?.activeGenerationId === generationId) {
      if (expectedSource.activeGenerationId) {
        await discardProjectionGeneration(context.storage.ontology, {
          projectId: context.projectId,
          source,
          generationId: expectedSource.activeGenerationId,
        })
      }
    } else {
      await discardProjectionGeneration(context.storage.ontology, {
        projectId: context.projectId,
        source,
        generationId,
      })
    }
    return result
  } catch (error) {
    await discardProjectionGeneration(context.storage.ontology, {
      projectId: context.projectId,
      source,
      generationId,
    })
    throw error
  } finally {
    await cleanupInactiveProjectionGenerations(context.storage.ontology, {
      projectId: context.projectId,
      committedAt: identity.committedAt,
      limit: context.batching.sourceStageRows,
    })
  }
}

function validateProjectionWatermark(
  active: Awaited<ReturnType<OntologyStorage["sources"]["getActive"]>>,
  next: PinnedDatasetVersion
): void {
  if (!active) return
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
