import type { TelemetryOntologyCommitIntent } from "../../materialization/commits"
import { MaterializationValidationError } from "../../materialization/errors"
import type {
  OntologyMaterializationOrigin,
  TelemetryAppend,
  TelemetryCommitResult,
} from "../../materialization/model"
import { telemetryOwnershipKey } from "../../materialization/refs"
import type { ProjectionRegistry } from "../../projections/registry"
import {
  isProjectionMaterializationRunStorage,
  type ProjectionRunMaterializationIdentity,
  type ProjectionRunMaterializationReplay,
  type Storage,
} from "../../storage"
import type { MaterializationSession, OntologyCommitWrite } from "../../storage/ontology"
import type { MaterializerContext, MaterializerStorage } from "../context"
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
  type TimedCommitIdentity,
} from "../shared/identity"
import { normalizeTelemetryAppend } from "../shared/normalize"
import { planTelemetryAppend, type TelemetryPlanCounts } from "./plan"

type NormalizedTelemetryAppend = ReturnType<typeof normalizeTelemetryAppend>
type NormalizedTelemetrySource = NormalizedTelemetryAppend["source"]
type RuntimeTelemetrySource = Extract<NormalizedTelemetrySource, { readonly kind: "runtime" }>
type ProjectionTelemetrySource = Extract<NormalizedTelemetrySource, { readonly kind: "projection" }>
type ResolvedTelemetryProjection = ReturnType<ProjectionRegistry["resolveTelemetry"]>

interface PreparedTelemetryBase {
  readonly input: NormalizedTelemetryAppend
  readonly inputPointCount: number
  readonly ontologyRevision: string
  readonly identity: TimedCommitIdentity
}

interface PreparedRuntimeTelemetry extends PreparedTelemetryBase {
  readonly kind: "runtime"
  readonly source: RuntimeTelemetrySource
}

interface PreparedProjectionTelemetry extends PreparedTelemetryBase {
  readonly kind: "projection"
  readonly source: ProjectionTelemetrySource
  readonly resolvedProjection: ResolvedTelemetryProjection
  readonly runIdentity: ProjectionRunMaterializationIdentity
  readonly replayProof: ProjectionRunMaterializationReplay
}

type PreparedTelemetryAppend = PreparedRuntimeTelemetry | PreparedProjectionTelemetry

export async function appendTelemetry(
  context: MaterializerContext,
  raw: TelemetryAppend
): Promise<TelemetryCommitResult> {
  const command = prepareTelemetryAppend(context, raw)
  await assertTelemetryExecution(context.storage, context.projectId, command)

  const replay = await replayTelemetryCommit(context, command)
  if (replay) return replay

  return executeTelemetryCommit(context, command)
}

function prepareTelemetryAppend(
  context: Pick<MaterializerContext, "projectId" | "ontology" | "projectionRegistry" | "clock">,
  raw: TelemetryAppend
): PreparedTelemetryAppend {
  const rawInputPointCount = raw.points.length
  const input = normalizeTelemetryAppend(raw)
  const inputPointCount = telemetryInputPointCount(input, rawInputPointCount)
  validateTelemetryBatch(context, input, inputPointCount)

  const ontologyRevision = context.projectionRegistry.ontologyRevision
  if (input.source.kind === "runtime") {
    return prepareRuntimeTelemetry(context, input, input.source, inputPointCount, ontologyRevision)
  }
  return prepareProjectionTelemetry(context, input, input.source, inputPointCount, ontologyRevision)
}

function telemetryInputPointCount(
  input: NormalizedTelemetryAppend,
  rawInputPointCount: number
): number {
  if (input.source.kind === "projection") return rawInputPointCount
  return input.points.length
}

function validateTelemetryBatch(
  context: Pick<MaterializerContext, "ontology">,
  input: NormalizedTelemetryAppend,
  inputPointCount: number
): void {
  if (input.source.kind === "projection" && inputPointCount === 0) {
    throw new MaterializationValidationError(
      "Projection telemetry batches must contain at least one physical input point; an empty dataset produces no batch commit."
    )
  }
  for (const point of input.points) validateTelemetryPoint(context.ontology, point)
}

function prepareRuntimeTelemetry(
  context: Pick<MaterializerContext, "projectId" | "clock">,
  input: NormalizedTelemetryAppend,
  source: RuntimeTelemetrySource,
  inputPointCount: number,
  ontologyRevision: string
): PreparedRuntimeTelemetry {
  const identity = createTimedCommitIdentity({
    projectId: context.projectId,
    idempotencyKey: createRuntimeTelemetryIdempotencyKey(source.requestId),
    normalizedCallerIntent: input,
    now: context.clock(),
  })
  return { kind: "runtime", input, source, inputPointCount, ontologyRevision, identity }
}

function prepareProjectionTelemetry(
  context: Pick<MaterializerContext, "projectId" | "projectionRegistry" | "clock">,
  input: NormalizedTelemetryAppend,
  source: ProjectionTelemetrySource,
  inputPointCount: number,
  ontologyRevision: string
): PreparedProjectionTelemetry {
  const resolvedProjection = context.projectionRegistry.resolveTelemetry(
    source.projection.projectionId
  )
  validateTelemetryProjectionDataset(resolvedProjection, source)
  validateTelemetryOwnership(resolvedProjection, input)

  const runIdentity = telemetryRunIdentity(ontologyRevision, resolvedProjection, source)
  const identity = createTimedCommitIdentity({
    projectId: context.projectId,
    idempotencyKey: createProjectionTelemetryIdempotencyKey({
      source: source.projection,
      projectionKind: "telemetry",
      datasetVersion: source.datasetVersion,
      ontologyRevision,
      projectionRevision: resolvedProjection.projectionRevision,
      ownershipHash: resolvedProjection.ownershipHash,
      batchOrdinal: source.batchOrdinal,
    }),
    // Execution ownership is transient: a reclaimed delivery retains the same request hash.
    normalizedCallerIntent: projectionTelemetryCallerIntent(input, source, inputPointCount),
    now: context.clock(),
  })
  const replayProof = telemetryReplayProof(source, resolvedProjection, runIdentity, identity)
  return {
    kind: "projection",
    input,
    source,
    inputPointCount,
    ontologyRevision,
    identity,
    resolvedProjection,
    runIdentity,
    replayProof,
  }
}

function telemetryRunIdentity(
  ontologyRevision: string,
  resolved: ResolvedTelemetryProjection,
  source: ProjectionTelemetrySource
): ProjectionRunMaterializationIdentity {
  return {
    projectionId: resolved.projectionId,
    projectionKind: "telemetry",
    protocol: "telemetry",
    datasetVersion: source.datasetVersion,
    ontologyRevision,
    projectionRevision: resolved.projectionRevision,
    ownershipHash: resolved.ownershipHash,
  }
}

function telemetryReplayProof(
  source: ProjectionTelemetrySource,
  resolved: ResolvedTelemetryProjection,
  runIdentity: ProjectionRunMaterializationIdentity,
  identity: TimedCommitIdentity
): ProjectionRunMaterializationReplay {
  return {
    kind: "projection",
    protocol: "telemetry",
    projectionId: resolved.projectionId,
    projectionKind: "telemetry",
    execution: source.execution,
    datasetVersion: source.datasetVersion,
    ontologyRevision: runIdentity.ontologyRevision,
    projectionRevision: runIdentity.projectionRevision,
    ownershipHash: runIdentity.ownershipHash,
    commitId: identity.commitId,
    batchOrdinal: source.batchOrdinal,
  }
}

function validateTelemetryProjectionDataset(
  resolved: ResolvedTelemetryProjection,
  source: ProjectionTelemetrySource
): void {
  if (resolved.datasetId === source.datasetVersion.datasetId) return
  throw new MaterializationValidationError(
    `Telemetry projection '${resolved.projectionId}' requires dataset '${resolved.datasetId}'.`
  )
}

function validateTelemetryOwnership(
  resolved: ResolvedTelemetryProjection,
  input: NormalizedTelemetryAppend
): void {
  const ownedSeries = new Set(
    resolved.ownership.telemetry.map(({ objectTypeId, propertyId }) =>
      telemetryOwnershipKey(objectTypeId, propertyId)
    )
  )
  for (const point of input.points) {
    const scope = telemetryOwnershipKey(point.series.object.objectTypeId, point.series.propertyId)
    if (ownedSeries.has(scope)) continue
    throw new MaterializationValidationError(
      `Telemetry projection '${resolved.projectionId}' does not own series '${point.series.object.objectTypeId}.${point.series.propertyId}'.`
    )
  }
}

function projectionTelemetryCallerIntent(
  input: NormalizedTelemetryAppend,
  source: ProjectionTelemetrySource,
  inputPointCount: number
) {
  const intent = {
    source: {
      kind: "projection" as const,
      projection: source.projection,
      datasetVersion: source.datasetVersion,
      batchOrdinal: source.batchOrdinal,
    },
    inputPointCount,
    points: input.points,
  }
  if (input.actor === undefined) return intent
  return { ...intent, actor: input.actor }
}

async function assertTelemetryExecution(
  storage: Storage,
  projectId: string,
  command: PreparedTelemetryAppend
): Promise<void> {
  if (command.kind === "runtime") return
  if (!isProjectionMaterializationRunStorage(storage.projectionRuns)) {
    throw new MaterializationValidationError(
      "Storage does not provide projection run capabilities required by telemetry projection."
    )
  }
  const run = await storage.projectionRuns.assertMaterializationExecution({
    id: command.source.execution.projectionRunId,
    projectId,
    executionToken: command.source.execution.executionToken,
    identity: command.runIdentity,
  })
  assertProjectionRunTargets(run, command.resolvedProjection)
}

async function replayTelemetryCommit(
  context: MaterializerContext,
  command: PreparedTelemetryAppend
): Promise<TelemetryCommitResult | null> {
  const replay = await replayCommit<TelemetryCommitResult>(context, command.identity)
  if (!replay) return null
  if (command.kind === "projection") {
    await attachRunReplayTransaction(context, command.replayProof)
  }
  return replay
}

async function executeTelemetryCommit(
  context: MaterializerContext,
  command: PreparedTelemetryAppend
): Promise<TelemetryCommitResult> {
  return withSerializationRetry(context, () =>
    context.storage.transaction(
      (txBase) => executeTelemetryTransaction(context, requireOntologyStorage(txBase), command),
      { isolation: "serializable" }
    )
  )
}

async function executeTelemetryTransaction(
  context: MaterializerContext,
  storage: MaterializerStorage,
  command: PreparedTelemetryAppend
): Promise<TelemetryCommitResult> {
  await assertTelemetryExecutionInTransaction(storage, context.projectId, command)
  const replay = await replayCommit<TelemetryCommitResult>(context, command.identity, storage)
  if (replay) {
    if (command.kind === "projection") {
      await attachRunReplay(storage, context.projectId, command.replayProof)
    }
    return replay
  }

  const origin = telemetryOrigin(command)
  const session = await beginTelemetryMaterialization(context, storage, command, origin)
  const counts = await planTelemetryAppend(
    context,
    storage.ontology.materializations,
    session,
    command.input,
    command.identity,
    origin
  )
  await drainStagedWork(context, storage.ontology.materializations, session)
  const eventCount = await drainStagedEvents(
    context,
    storage.ontology.materializations,
    session,
    command.identity
  )
  const result: TelemetryCommitResult = {
    kind: "telemetry",
    commitId: command.identity.commitId,
    created: true,
    eventCount,
    ...counts,
  }
  return finalizeTelemetryMaterialization(storage, session, command, counts, result)
}

async function assertTelemetryExecutionInTransaction(
  storage: Storage,
  projectId: string,
  command: PreparedTelemetryAppend
): Promise<void> {
  if (command.kind === "runtime") return
  if (!isProjectionMaterializationRunStorage(storage.projectionRuns)) {
    throw new MaterializationValidationError(
      "Storage transaction does not provide projection run capabilities."
    )
  }
  const run = await storage.projectionRuns.assertMaterializationExecution({
    id: command.source.execution.projectionRunId,
    projectId,
    executionToken: command.source.execution.executionToken,
    identity: command.runIdentity,
  })
  assertProjectionRunTargets(run, command.resolvedProjection)
}

function telemetryOrigin(command: PreparedTelemetryAppend): OntologyMaterializationOrigin {
  if (command.kind === "runtime") {
    return { kind: "telemetry", source: command.source }
  }
  return {
    kind: "telemetry",
    source: {
      kind: "projection",
      projectionId: command.source.projection.projectionId,
      projectionRunId: command.source.execution.projectionRunId,
      datasetId: command.source.datasetVersion.datasetId,
      datasetVersionId: command.source.datasetVersion.versionId,
      batchOrdinal: command.source.batchOrdinal,
    },
  }
}

async function beginTelemetryMaterialization(
  context: Pick<MaterializerContext, "projectId">,
  storage: MaterializerStorage,
  command: PreparedTelemetryAppend,
  origin: OntologyMaterializationOrigin
): Promise<MaterializationSession> {
  return storage.ontology.materializations.begin({
    commit: telemetryCommit(context.projectId, command, origin),
    expected: {
      sources: [],
      objects: [],
      links: [],
      linkScopes: [],
      points: [],
    },
  })
}

function telemetryCommit(
  projectId: string,
  command: PreparedTelemetryAppend,
  origin: OntologyMaterializationOrigin
): OntologyCommitWrite {
  const base: OntologyCommitWrite = {
    projectId,
    id: command.identity.commitId,
    idempotencyKey: command.identity.idempotencyKey,
    requestHash: command.identity.requestHash,
    origin,
    ontologyRevision: command.ontologyRevision,
    intent: telemetryCommitIntent(command),
    committedAt: command.identity.committedAt,
  }
  const withActor = telemetryCommitActor(base, command)
  if (command.kind === "runtime") return withActor
  return {
    ...withActor,
    projectionRevision: command.resolvedProjection.projectionRevision,
    ownershipHash: command.resolvedProjection.ownershipHash,
  }
}

function telemetryCommitActor(
  commit: OntologyCommitWrite,
  command: PreparedTelemetryAppend
): OntologyCommitWrite {
  if (command.input.actor === undefined) return commit
  return { ...commit, actor: command.input.actor }
}

function telemetryCommitIntent(command: PreparedTelemetryAppend): TelemetryOntologyCommitIntent {
  if (command.kind === "runtime") {
    return {
      kind: "telemetry",
      pointCount: command.input.points.length,
      inputPointCount: command.inputPointCount,
      source: { kind: "runtime" },
    }
  }
  return {
    kind: "telemetry",
    pointCount: command.input.points.length,
    inputPointCount: command.inputPointCount,
    source: {
      kind: "projection",
      projection: command.source.projection,
      datasetVersion: command.source.datasetVersion,
      batchOrdinal: command.source.batchOrdinal,
    },
  }
}

async function finalizeTelemetryMaterialization(
  storage: MaterializerStorage,
  session: MaterializationSession,
  command: PreparedTelemetryAppend,
  counts: TelemetryPlanCounts,
  result: TelemetryCommitResult
): Promise<TelemetryCommitResult> {
  if (command.kind === "runtime") {
    const applied = await storage.ontology.materializations.finalize({
      session,
      finalization: { sourceActivations: [], result },
    })
    return applied.commit.result as TelemetryCommitResult
  }

  const applied = await storage.ontology.materializations.finalize({
    session,
    finalization: {
      sourceActivations: [],
      result,
      bookkeeping: {
        kind: "projection",
        protocol: "telemetry",
        projectionId: command.resolvedProjection.projectionId,
        projectionKind: "telemetry",
        execution: command.source.execution,
        datasetVersion: command.source.datasetVersion,
        ontologyRevision: command.ontologyRevision,
        projectionRevision: command.resolvedProjection.projectionRevision,
        ownershipHash: command.resolvedProjection.ownershipHash,
        commitId: command.identity.commitId,
        batchOrdinal: command.source.batchOrdinal,
        batchInputCount: command.inputPointCount,
        batchPointCount: command.input.points.length,
        ...counts,
      },
    },
  })
  return applied.commit.result as TelemetryCommitResult
}
