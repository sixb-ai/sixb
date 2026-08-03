import { isSixbError, SixbError } from "../../errors"
import { assertPinnedDatasetWatermark } from "../../materialization/dataset-watermark"
import {
  isMaterializationCancellation,
  materializationConflict,
  materializationConflictKind,
} from "../../materialization/errors"
import type {
  OntologyMaterializationOrigin,
  PinnedDatasetVersion,
  ProjectionCommitResult,
  ProjectionExecution,
  ProjectionMaterializationIdentity,
  ProjectionSourceEntry,
  ProjectionSourceRef,
  ProjectionSourceReplacement,
} from "../../materialization/model"
import type { ProjectionRegistry } from "../../projections/registry"
import type {
  OntologyCommitRecord,
  OntologyCommitWrite,
  OntologyMaterializationStorage,
  OntologyStorage,
} from "../../storage/ontology"
import type { MaterializerContext, MaterializerStorage } from "../context"
import { replayCommitRecord, withSerializationRetry } from "../execution/commit-lifecycle"
import { lockProjectionRunForMaterialization } from "../execution/run-correlation"
import { drainStagedEvents, drainStagedWork } from "../execution/work-executor"
import { throwIfAborted } from "../shared/abort"
import {
  type CommitIdentity,
  createCommitIdentity,
  createProjectionIdempotencyKey,
  type TimedCommitIdentity,
  timestampCommitIdentity,
} from "../shared/identity"
import {
  normalizePinnedDatasetVersion,
  normalizeProjectionExecution,
  normalizeProjectionSourceRef,
} from "../shared/normalize"
import { createProjectionRunMaterializationIdentity } from "../shared/projection-run"
import { createProjectionEntryValidator } from "./entry-validator"
import { planProjectionReplacement } from "./replacement-plan"
import {
  type StagedProjectionMaterialization,
  stageProjectionMaterialization,
} from "./source-materialization"

type ResolvedSourceProjection = ReturnType<ProjectionRegistry["resolveSource"]>

interface PreparedProjectionReplacement {
  readonly source: ProjectionSourceRef
  readonly datasetVersion: PinnedDatasetVersion
  readonly execution: ProjectionExecution
  readonly entries: AsyncIterable<ProjectionSourceEntry>
  readonly signal?: AbortSignal
  readonly resolved: ResolvedSourceProjection
  readonly projectionKind: "object" | "link"
  readonly runIdentity: ProjectionMaterializationIdentity
  readonly identity: CommitIdentity
}

interface ProjectionCandidate {
  readonly materializationId: string
  readonly createdAt: string
  readonly expectedSource: {
    readonly source: ProjectionSourceRef
    readonly activeMaterializationId: string | null
    readonly lastCommitId: string | null
  }
}

interface ReadyProjectionReplacement extends ProjectionCandidate {
  readonly staged: StagedProjectionMaterialization
  readonly identity: TimedCommitIdentity
}

export async function replaceProjection(
  context: MaterializerContext,
  raw: ProjectionSourceReplacement
): Promise<ProjectionCommitResult> {
  const command = prepareProjectionReplacement(context, raw)
  await assertProjectionExecution(context.storage, context.projectId, command, {
    capabilityErrorMessage:
      "Storage does not provide projection run capabilities required by source replacement.",
  })

  const replay = await replayProjectionCommit(context, command)
  if (replay) return replay

  const candidate = await prepareProjectionCandidate(context, command)
  try {
    const ready = await stageProjectionCandidate(context, command, candidate)
    return await commitProjectionCandidate(context, command, ready)
  } catch (error) {
    await abandonFailedCandidate(context, command, candidate, error)
    throw error
  }
}

function prepareProjectionReplacement(
  context: Pick<MaterializerContext, "projectId" | "projectionRegistry">,
  raw: ProjectionSourceReplacement
): PreparedProjectionReplacement {
  const source = normalizeProjectionSourceRef(raw.source)
  const datasetVersion = normalizePinnedDatasetVersion(raw.datasetVersion)
  const execution = normalizeProjectionExecution(raw.execution)
  const resolved = context.projectionRegistry.resolveSource(source.projectionId)
  validateProjectionDataset(resolved, datasetVersion)

  const projectionKind = sourceProjectionKind(resolved)
  const runIdentity = createProjectionRunMaterializationIdentity({
    resolved,
    datasetVersion,
    ontologyRevision: context.projectionRegistry.ontologyRevision,
  })
  const identity = createCommitIdentity({
    projectId: context.projectId,
    idempotencyKey: createProjectionIdempotencyKey(runIdentity),
    normalizedCallerIntent: { source, datasetVersion },
  })
  const command = {
    source,
    datasetVersion,
    execution,
    entries: raw.entries,
    resolved,
    projectionKind,
    runIdentity,
    identity,
  }
  if (raw.signal === undefined) return command
  return { ...command, signal: raw.signal }
}

function validateProjectionDataset(
  resolved: ResolvedSourceProjection,
  datasetVersion: PinnedDatasetVersion
): void {
  if (datasetVersion.datasetId === resolved.datasetId) return
  throw new SixbError(
    "ontology.invalid_value",
    `[Sixb] Projection '${resolved.projectionId}' requires dataset '${resolved.datasetId}'.`
  )
}

function sourceProjectionKind(resolved: ResolvedSourceProjection): "object" | "link" {
  if (resolved.definition._tag === "ObjectProjectionDefinition") return "object"
  return "link"
}

async function assertProjectionExecution(
  storage: MaterializerStorage,
  projectId: string,
  command: PreparedProjectionReplacement,
  options: { readonly capabilityErrorMessage?: string } = {}
): Promise<void> {
  await lockProjectionRunForMaterialization(storage, {
    projectId,
    projectionRunId: command.execution.projectionRunId,
    executionToken: command.execution.executionToken,
    identity: command.runIdentity,
    resolved: command.resolved,
    ...options,
  })
}

async function replayProjectionCommit(
  context: MaterializerContext,
  command: PreparedProjectionReplacement
): Promise<ProjectionCommitResult | null> {
  const existing = await replayCommitRecord(context, command.identity)
  if (!existing) return null
  return withSerializationRetry(context, () =>
    context.storage.transaction(
      async (storage) => {
        await assertProjectionExecution(storage, context.projectId, command)
        const commit = await replayCommitRecord(context, command.identity, storage)
        return commit ? projectionReplayResult(commit, command) : null
      },
      { isolation: "serializable" }
    )
  )
}

function projectionReplayResult(
  commit: OntologyCommitRecord,
  command: PreparedProjectionReplacement
): ProjectionCommitResult {
  if (
    commit.origin.kind !== "projection" ||
    commit.origin.projectionRunId !== command.execution.projectionRunId ||
    commit.result.kind !== "projection"
  ) {
    throw materializationConflict(
      "run-correlation",
      `Projection commit '${commit.id}' belongs to a different logical run.`
    )
  }
  return { ...structuredClone(commit.result), created: false }
}

async function prepareProjectionCandidate(
  context: MaterializerContext,
  command: PreparedProjectionReplacement
): Promise<ProjectionCandidate> {
  await context.storage.ontology.sources.abandon({
    kind: "reclaim",
    projectId: context.projectId,
    source: command.source,
    execution: command.execution,
    abandonedAt: context.clock().toISOString(),
  })
  const active = await context.storage.ontology.sources.getActive({
    projectId: context.projectId,
    source: command.source,
  })
  validateProjectionWatermark(active, command.datasetVersion)
  return {
    materializationId: context.materializationId(),
    createdAt: context.clock().toISOString(),
    expectedSource: {
      source: command.source,
      activeMaterializationId: active?.materializationId ?? null,
      lastCommitId: active?.lastCommitId ?? null,
    },
  }
}

async function stageProjectionCandidate(
  context: MaterializerContext,
  command: PreparedProjectionReplacement,
  candidate: ProjectionCandidate
): Promise<ReadyProjectionReplacement> {
  const input = {
    source: command.source,
    materializationId: candidate.materializationId,
    execution: command.execution,
    projectionKind: command.projectionKind,
    datasetVersion: command.datasetVersion,
    projectionRevision: command.resolved.projectionRevision,
    ownershipHash: command.resolved.ownershipHash,
    createdAt: candidate.createdAt,
    entries: command.entries,
    validateEntry: createProjectionEntryValidator(context.ontology, command.resolved),
  }
  const staged = await stageCandidateEntries(context, input, command.signal)
  return {
    ...candidate,
    staged,
    // Commit time starts only after the source candidate is sealed ready.
    identity: timestampCommitIdentity(command.identity, context.clock()),
  }
}

async function stageCandidateEntries(
  context: MaterializerContext,
  input: Parameters<typeof stageProjectionMaterialization>[1],
  signal: AbortSignal | undefined
): Promise<StagedProjectionMaterialization> {
  if (signal === undefined) return stageProjectionMaterialization(context, input)
  return stageProjectionMaterialization(context, { ...input, signal })
}

async function commitProjectionCandidate(
  context: MaterializerContext,
  command: PreparedProjectionReplacement,
  ready: ReadyProjectionReplacement
): Promise<ProjectionCommitResult> {
  return withSerializationRetry(context, () =>
    context.storage.transaction(
      (storage) => executeProjectionTransaction(context, storage, command, ready),
      { isolation: "serializable" }
    )
  )
}

async function executeProjectionTransaction(
  context: MaterializerContext,
  storage: MaterializerStorage,
  command: PreparedProjectionReplacement,
  ready: ReadyProjectionReplacement
): Promise<ProjectionCommitResult> {
  await assertProjectionExecution(storage, context.projectId, command)
  const replay = await replayCommitRecord(context, command.identity, storage)
  if (replay) return projectionReplayResult(replay, command)

  const origin = projectionOrigin(command)
  throwIfAborted(command.signal)
  const session = await storage.ontology.materializations.begin({
    commit: projectionCommit(context.projectId, command, ready.identity, origin),
    expected: {
      sources: [ready.expectedSource],
      objects: [],
      links: [],
      linkScopes: [],
      points: [],
    },
  })
  const counts = await planReadyProjection(
    context,
    storage.ontology.materializations,
    session,
    command,
    ready,
    origin
  )
  await drainStagedWork(context, storage.ontology.materializations, session, command.signal)
  const eventCount = await drainStagedEvents(
    context,
    storage.ontology.materializations,
    session,
    ready.identity,
    command.signal
  )
  const result: ProjectionCommitResult = {
    kind: "projection",
    commitId: ready.identity.commitId,
    created: true,
    eventCount,
    committedAt: ready.identity.committedAt,
    counts,
  }
  throwIfAborted(command.signal)
  return finalizeProjectionMaterialization(storage, session, command, ready, result)
}

async function finalizeProjectionMaterialization(
  storage: MaterializerStorage,
  session: Parameters<OntologyMaterializationStorage["finalize"]>[0]["session"],
  command: PreparedProjectionReplacement,
  ready: ReadyProjectionReplacement,
  result: ProjectionCommitResult
): Promise<ProjectionCommitResult> {
  const applied = await storage.ontology.materializations.finalize({
    session,
    finalization: {
      sourceActivations: [projectionActivation(command, ready)],
      result,
    },
  })
  return applied.commit.result as ProjectionCommitResult
}

function projectionOrigin(command: PreparedProjectionReplacement): OntologyMaterializationOrigin {
  return {
    kind: "projection",
    projectionId: command.resolved.projectionId,
    projectionRunId: command.execution.projectionRunId,
    datasetId: command.datasetVersion.datasetId,
    datasetVersionId: command.datasetVersion.versionId,
  }
}

function projectionCommit(
  projectId: string,
  command: PreparedProjectionReplacement,
  identity: TimedCommitIdentity,
  origin: OntologyMaterializationOrigin
): OntologyCommitWrite {
  return {
    projectId,
    id: identity.commitId,
    idempotencyKey: identity.idempotencyKey,
    requestHash: identity.requestHash,
    origin,
    ontologyRevision: command.runIdentity.ontologyRevision,
    projectionRevision: command.runIdentity.projectionRevision,
    ownershipHash: command.runIdentity.ownershipHash,
    intent: { kind: "projection", source: command.source, datasetVersion: command.datasetVersion },
    committedAt: identity.committedAt,
  }
}

async function planReadyProjection(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: Parameters<OntologyMaterializationStorage["finalize"]>[0]["session"],
  command: PreparedProjectionReplacement,
  ready: ReadyProjectionReplacement,
  origin: OntologyMaterializationOrigin
) {
  const input = {
    source: command.source,
    materializationId: ready.materializationId,
    projectionKind: command.projectionKind,
    identity: ready.identity,
    origin,
  }
  if (command.signal === undefined) {
    return planProjectionReplacement(context, storage, session, input)
  }
  return planProjectionReplacement(context, storage, session, {
    ...input,
    signal: command.signal,
  })
}

function projectionActivation(
  command: PreparedProjectionReplacement,
  ready: ReadyProjectionReplacement
) {
  return {
    source: command.source,
    materializationId: ready.materializationId,
    execution: command.execution,
    projectionKind: command.projectionKind,
    protocol: "replacement" as const,
    datasetVersion: command.datasetVersion,
    projectionRevision: command.runIdentity.projectionRevision,
    ownershipHash: command.runIdentity.ownershipHash,
    ontologyRevision: command.runIdentity.ontologyRevision,
    expected: ready.expectedSource,
    lastCommitId: ready.identity.commitId,
    updatedAt: ready.identity.committedAt,
  }
}

async function abandonFailedCandidate(
  context: MaterializerContext,
  command: PreparedProjectionReplacement,
  candidate: ProjectionCandidate,
  error: unknown
): Promise<void> {
  if (!shouldAbandonCandidate(error)) return
  await context.storage.ontology.sources.abandon({
    kind: "candidate",
    projectId: context.projectId,
    source: command.source,
    materializationId: candidate.materializationId,
    execution: command.execution,
    abandonedAt: context.clock().toISOString(),
  })
}

function shouldAbandonCandidate(error: unknown): boolean {
  if (isSixbError(error, "ontology.invalid_value")) return true
  if (isMaterializationCancellation(error)) return true
  return materializationConflictKind(error) === "run-correlation"
}

function validateProjectionWatermark(
  active: Awaited<ReturnType<OntologyStorage["sources"]["getActive"]>>,
  next: PinnedDatasetVersion
): void {
  if (!active) return
  assertPinnedDatasetWatermark(active.datasetVersion, next, "Projection replacement")
}
