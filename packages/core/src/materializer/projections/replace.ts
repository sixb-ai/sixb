import { assertPinnedDatasetWatermark } from "../../materialization/dataset-watermark"
import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type {
  OntologyMaterializationOrigin,
  PinnedDatasetVersion,
  ProjectionCommitResult,
  ProjectionExecution,
  ProjectionMaterializationIdentity,
  ProjectionSourceBase,
  ProjectionSourceDeletion,
  ProjectionSourceEntry,
  ProjectionSourceRef,
  ProjectionSourceReplacement,
} from "../../materialization/model"
import type { ProjectionRegistry } from "../../projections/registry"
import type {
  AdoptedSourceMaterialization,
  OntologyCommitRecord,
  OntologyCommitWrite,
  OntologyMaterializationStorage,
  OntologySourceRecord,
  OntologyStorage,
} from "../../storage/ontology"
import type { MaterializerContext, MaterializerStorage } from "../context"
import { replayCommitRecord, withSerializationRetry } from "../execution/commit-lifecycle"
import { lockProjectionRunForMaterialization } from "../execution/run-correlation"
import {
  assertMaterializerRunExecution,
  assertTrustedPrimitiveMutationExecution,
  ensureMaterializerExecution,
  type MaterializerExecution,
  prepareMaterializerExecution,
} from "../execution/scope"
import { drainStagedEvents, drainStagedWork } from "../execution/work-executor"
import type { MaterializerCommand } from "../materializer"
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
  readonly entries: AsyncIterable<ProjectionSourceEntry | ProjectionSourceDeletion>
  readonly base?: ProjectionSourceBase
  readonly signal?: AbortSignal
  readonly resolved: ResolvedSourceProjection
  readonly projectionKind: "object" | "link"
  readonly runIdentity: ProjectionMaterializationIdentity
  readonly identity: CommitIdentity
  readonly scopeExecution: MaterializerExecution
}

interface ProjectionCandidate {
  readonly materializationId: string
  readonly createdAt: string
  /** Set when a redelivery adopted the candidate a previous execution of this run staged. */
  readonly adopted?: AdoptedSourceMaterialization
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
  raw: MaterializerCommand<ProjectionSourceReplacement>
): Promise<ProjectionCommitResult> {
  const command = prepareProjectionReplacement(context, raw)
  const replay = await admitProjectionExecution(context, command)
  if (replay) return replay

  // A failed attempt leaves its candidate to the run: a redelivery adopts it, and the run's
  // terminal transition (`finishRun`) abandons it.
  const candidate = await prepareProjectionCandidate(context, command)
  const ready = await stageProjectionCandidate(context, command, candidate)
  return commitProjectionCandidate(context, command, ready)
}

function prepareProjectionReplacement(
  context: Pick<MaterializerContext, "projectId" | "projectionRegistry">,
  raw: MaterializerCommand<ProjectionSourceReplacement>
): PreparedProjectionReplacement {
  const source = normalizeProjectionSourceRef(raw.input.source)
  const datasetVersion = normalizePinnedDatasetVersion(raw.input.datasetVersion)
  const execution = normalizeProjectionExecution(raw.input.execution)
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
    entries: raw.input.entries,
    ...(raw.input.base ? { base: Object.freeze({ ...raw.input.base }) } : {}),
    resolved,
    projectionKind,
    runIdentity,
    identity,
    scopeExecution: prepareMaterializerExecution(context.projectId, raw.scope),
  }
  if (raw.input.signal === undefined) return command
  return { ...command, signal: raw.input.signal }
}

function validateProjectionDataset(
  resolved: ResolvedSourceProjection,
  datasetVersion: PinnedDatasetVersion
): void {
  if (datasetVersion.datasetId === resolved.datasetId) return
  throw new MaterializationValidationError(
    `Projection '${resolved.projectionId}' requires dataset '${resolved.datasetId}'.`
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
  assertTrustedPrimitiveMutationExecution(command.scopeExecution, {
    kind: "projection",
    id: command.source.projectionId,
    runId: command.execution.projectionRunId,
  })
  const locked = await lockProjectionRunForMaterialization(storage, {
    projectId,
    projectionRunId: command.execution.projectionRunId,
    executionToken: command.execution.executionToken,
    identity: command.runIdentity,
    resolved: command.resolved,
    ...options,
  })
  assertMaterializerRunExecution(
    command.scopeExecution,
    locked.run.executionId,
    `Projection run '${locked.run.id}'`
  )
}

async function admitProjectionExecution(
  context: MaterializerContext,
  command: PreparedProjectionReplacement
): Promise<ProjectionCommitResult | null> {
  return withSerializationRetry(context, () =>
    context.storage.transaction(
      async (storage) => {
        await ensureMaterializerExecution(storage.executions, command.scopeExecution)
        await assertProjectionExecution(storage, context.projectId, command, {
          capabilityErrorMessage:
            "Storage does not provide projection run capabilities required by source replacement.",
        })
        const commit = await replayCommitRecord(
          context,
          command.identity,
          command.scopeExecution.executionId,
          storage
        )
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
    throw new MaterializationConflictError(
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
  const adopted = await context.storage.ontology.sources.adopt({
    projectId: context.projectId,
    source: command.source,
    execution: command.execution,
    adoptedAt: context.clock().toISOString(),
  })
  const active = await context.storage.ontology.sources.getActive({
    projectId: context.projectId,
    source: command.source,
  })
  validateProjectionWatermark(active, command.datasetVersion)
  assertDeltaBase(active, command)
  const expectedSource = {
    source: command.source,
    activeMaterializationId: active?.materializationId ?? null,
    lastCommitId: active?.lastCommitId ?? null,
  }
  if (adopted && sameSourceBase(adopted.record.base, command.base)) {
    return {
      materializationId: adopted.record.materializationId,
      createdAt: adopted.record.createdAt,
      adopted,
      expectedSource,
    }
  }
  if (adopted) {
    // Staged against another delta base (the active source moved, or this attempt reads the
    // whole version): its roots answer a different question, so it cannot be completed.
    await context.storage.ontology.sources.abandon({
      kind: "candidate",
      projectId: context.projectId,
      source: command.source,
      materializationId: adopted.record.materializationId,
      execution: command.execution,
      abandonedAt: context.clock().toISOString(),
    })
  }
  return {
    materializationId: context.materializationId(),
    createdAt: context.clock().toISOString(),
    expectedSource,
  }
}

async function stageProjectionCandidate(
  context: MaterializerContext,
  command: PreparedProjectionReplacement,
  candidate: ProjectionCandidate
): Promise<ReadyProjectionReplacement> {
  const staged = await stageOrReuseCandidate(context, command, candidate)
  return {
    ...candidate,
    staged,
    // Commit time starts only after the source candidate is sealed ready.
    identity: timestampCommitIdentity(command.identity, context.clock()),
  }
}

async function stageOrReuseCandidate(
  context: MaterializerContext,
  command: PreparedProjectionReplacement,
  candidate: ProjectionCandidate
): Promise<StagedProjectionMaterialization> {
  const adopted = candidate.adopted?.record
  if (adopted?.status === "ready" && adopted.rootCount !== null) {
    // The entries are left unread: the pinned version and definition that produced this candidate
    // are the ones this run is bound to.
    return { rootCount: adopted.rootCount, assertionCount: adopted.assertionCount ?? 0 }
  }
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
    ...(command.base ? { base: command.base } : {}),
    resumeStagingOrdinal: candidate.adopted?.resumeStagingOrdinal ?? 0,
    validateEntry: createProjectionEntryValidator(context.ontology, command.resolved),
  }
  return stageCandidateEntries(context, input, command.signal)
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
  await ensureMaterializerExecution(storage.executions, command.scopeExecution)
  await assertProjectionExecution(storage, context.projectId, command)
  const replay = await replayCommitRecord(
    context,
    command.identity,
    command.scopeExecution.executionId,
    storage
  )
  if (replay) return projectionReplayResult(replay, command)

  if (command.base) {
    const active = await storage.ontology.sources.getActive({
      projectId: context.projectId,
      source: command.source,
    })
    validateProjectionWatermark(active, command.datasetVersion)
    assertDeltaBase(active, command)
  }
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
  await drainStagedWork(context, storage, session, command.signal, true)
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
    executionId: command.scopeExecution.executionId,
    origin,
    ...command.scopeExecution.attribution,
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
    correlationId: command.scopeExecution.correlationId,
    attribution: command.scopeExecution.attribution,
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

function validateProjectionWatermark(
  active: Awaited<ReturnType<OntologyStorage["sources"]["getActive"]>>,
  next: PinnedDatasetVersion
): void {
  if (!active) return
  assertPinnedDatasetWatermark(active.datasetVersion, next, "Projection replacement")
}

function sameSourceBase(
  left: ProjectionSourceBase | undefined,
  right: ProjectionSourceBase | undefined
): boolean {
  return (
    left?.materializationId === right?.materializationId &&
    left?.lastCommitId === right?.lastCommitId
  )
}

function assertDeltaBase(
  active: OntologySourceRecord | null,
  command: PreparedProjectionReplacement
): void {
  if (
    command.base &&
    (!active ||
      active.materializationId !== command.base.materializationId ||
      active.lastCommitId !== command.base.lastCommitId ||
      active.projectionRevision !== command.runIdentity.projectionRevision ||
      active.ontologyRevision !== command.runIdentity.ontologyRevision ||
      active.ownershipHash !== command.runIdentity.ownershipHash)
  ) {
    throw new MaterializationConflictError(
      "source-materialization",
      "Projection delta no longer matches the active source or its definition."
    )
  }
}
