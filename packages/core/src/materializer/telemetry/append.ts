import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type {
  OntologyMaterializationOrigin,
  ProjectionMaterializationIdentity,
  TelemetryAppend,
  TelemetryCommitResult,
} from "../../materialization/model"
import { telemetryOwnershipKey } from "../../materialization/refs"
import type { ProjectionRegistry } from "../../projections/registry"
import type { ProjectionRunRecord, ProjectionRunStorage } from "../../storage"
import type {
  MaterializationSession,
  OntologyCommitRecord,
  OntologyCommitWrite,
  TelemetryOntologyCommitIntent,
} from "../../storage/ontology"
import type { MaterializerContext, MaterializerStorage } from "../context"
import { validateTelemetryPoint } from "../effective/validate"
import { replayCommitRecord, withSerializationRetry } from "../execution/commit-lifecycle"
import {
  type LockedProjectionExecution,
  lockProjectionRunForMaterialization,
} from "../execution/run-correlation"
import {
  assertMaterializerRunExecution,
  assertRuntimeMutationExecution,
  assertTrustedPrimitiveMutationExecution,
  ensureMaterializerExecution,
  type MaterializerExecution,
  prepareMaterializerExecution,
} from "../execution/scope"
import { drainStagedEvents, drainStagedWork } from "../execution/work-executor"
import type { MaterializerCommand } from "../materializer"
import {
  createProjectionTelemetryIdempotencyKey,
  createRuntimeTelemetryIdempotencyKey,
  createTimedCommitIdentity,
  type TimedCommitIdentity,
} from "../shared/identity"
import { normalizeTelemetryAppend } from "../shared/normalize"
import { createProjectionRunMaterializationIdentity } from "../shared/projection-run"
import { planTelemetryAppend } from "./plan"

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
  readonly execution: MaterializerExecution
}

interface PreparedRuntimeTelemetry extends PreparedTelemetryBase {
  readonly kind: "runtime"
  readonly source: RuntimeTelemetrySource
}

interface PreparedProjectionTelemetry extends PreparedTelemetryBase {
  readonly kind: "projection"
  readonly source: ProjectionTelemetrySource
  readonly resolvedProjection: ResolvedTelemetryProjection
  readonly runIdentity: ProjectionMaterializationIdentity
}

type PreparedTelemetryAppend = PreparedRuntimeTelemetry | PreparedProjectionTelemetry

export async function appendTelemetry(
  context: MaterializerContext,
  raw: MaterializerCommand<TelemetryAppend>
): Promise<TelemetryCommitResult> {
  const command = prepareTelemetryAppend(context, raw)
  return executeTelemetryCommit(context, command)
}

function prepareTelemetryAppend(
  context: Pick<MaterializerContext, "projectId" | "ontology" | "projectionRegistry" | "clock">,
  raw: MaterializerCommand<TelemetryAppend>
): PreparedTelemetryAppend {
  const rawInputPointCount = raw.input.points.length
  const input = normalizeTelemetryAppend({
    ...raw.input,
    points: raw.input.points.map((point) => validateTelemetryPoint(context.ontology, point)),
  })
  const inputPointCount = telemetryInputPointCount(input, rawInputPointCount)

  const ontologyRevision = context.projectionRegistry.ontologyRevision
  const execution = prepareMaterializerExecution(context.projectId, raw.scope)
  if (input.source.kind === "runtime") {
    return {
      ...prepareRuntimeTelemetry(context, input, input.source, inputPointCount, ontologyRevision),
      execution,
    }
  }
  return {
    ...prepareProjectionTelemetry(context, input, input.source, inputPointCount, ontologyRevision),
    execution,
  }
}

function telemetryInputPointCount(
  input: NormalizedTelemetryAppend,
  rawInputPointCount: number
): number {
  if (input.source.kind === "projection") return rawInputPointCount
  return input.points.length
}

function prepareRuntimeTelemetry(
  context: Pick<MaterializerContext, "projectId" | "clock">,
  input: NormalizedTelemetryAppend,
  source: RuntimeTelemetrySource,
  inputPointCount: number,
  ontologyRevision: string
): Omit<PreparedRuntimeTelemetry, "execution"> {
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
): Omit<PreparedProjectionTelemetry, "execution"> {
  const resolvedProjection = context.projectionRegistry.resolveTelemetry(
    source.projection.projectionId
  )
  validateTelemetryProjectionDataset(resolvedProjection, source)
  validateTelemetryOwnership(resolvedProjection, input)
  validateTelemetryBatchCardinality(resolvedProjection, source, inputPointCount)

  const runIdentity = createProjectionRunMaterializationIdentity({
    resolved: resolvedProjection,
    datasetVersion: source.datasetVersion,
    ontologyRevision,
  })
  const identity = createTimedCommitIdentity({
    projectId: context.projectId,
    idempotencyKey: createProjectionTelemetryIdempotencyKey(runIdentity, source.batchOrdinal),
    // Execution ownership is transient: a reclaimed delivery retains the same request hash.
    normalizedCallerIntent: projectionTelemetryCallerIntent(input, source, inputPointCount),
    now: context.clock(),
  })
  return {
    kind: "projection",
    input,
    source,
    inputPointCount,
    ontologyRevision,
    identity,
    resolvedProjection,
    runIdentity,
  }
}

function validateTelemetryBatchCardinality(
  resolved: ResolvedTelemetryProjection,
  source: ProjectionTelemetrySource,
  inputPointCount: number
): void {
  if (source.sourceRowCount === 0) {
    throw new MaterializationValidationError(
      "Projection telemetry batches must consume at least one source row; an empty dataset produces no batch commit."
    )
  }

  const mappedPropertyCount = resolved.ownership.telemetry.length
  if (mappedPropertyCount === 0) {
    throw new MaterializationValidationError(
      `Telemetry projection '${resolved.projectionId}' must own at least one telemetry property.`
    )
  }

  const sourceRowsEmitted = source.sourceRowCount - source.sourceRowsSkipped
  const maximumPointCount = sourceRowsEmitted * mappedPropertyCount
  if (!Number.isSafeInteger(maximumPointCount)) {
    throw new MaterializationValidationError(
      `Telemetry projection '${resolved.projectionId}' batch point capacity exceeds the safe integer range.`
    )
  }
  if (inputPointCount < sourceRowsEmitted || inputPointCount > maximumPointCount) {
    throw new MaterializationValidationError(
      `Telemetry projection '${resolved.projectionId}' must emit between ${sourceRowsEmitted} and ${maximumPointCount} points for ${source.sourceRowCount} source rows with ${source.sourceRowsSkipped} skipped.`
    )
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
      sourceRowCount: source.sourceRowCount,
      sourceRowsSkipped: source.sourceRowsSkipped,
      inputExhausted: source.inputExhausted,
    },
    inputPointCount,
    points: input.points,
  }
  return intent
}

async function assertTelemetryExecution(
  storage: MaterializerStorage,
  projectId: string,
  command: PreparedTelemetryAppend
): Promise<LockedProjectionExecution | null> {
  if (command.kind === "runtime") {
    assertRuntimeMutationExecution(command.execution)
    return null
  }
  assertTrustedPrimitiveMutationExecution(command.execution, {
    kind: "projection",
    id: command.source.projection.projectionId,
    runId: command.source.execution.projectionRunId,
  })
  const execution = await lockProjectionRunForMaterialization(storage, {
    projectId,
    projectionRunId: command.source.execution.projectionRunId,
    executionToken: command.source.execution.executionToken,
    identity: command.runIdentity,
    resolved: command.resolvedProjection,
    capabilityErrorMessage:
      "Storage does not provide projection run capabilities required by telemetry projection.",
  })
  assertMaterializerRunExecution(
    command.execution,
    execution.run.executionId,
    `Projection run '${execution.run.id}'`
  )
  assertTelemetryBatchPosition(
    execution.run,
    command.source.batchOrdinal,
    command.source.sourceRowCount,
    command.source.inputExhausted
  )
  return execution
}

function assertTelemetryBatchPosition(
  run: ProjectionRunRecord,
  batchOrdinal: number,
  sourceRowCount: number,
  inputExhausted: boolean
): void {
  const checkpoint = run.telemetryCheckpoint
  if (!checkpoint) {
    throw new MaterializationValidationError(
      `Telemetry projection run '${run.id}' has incomplete checkpoint state.`
    )
  }
  if (batchOrdinal > checkpoint.nextBatchOrdinal) {
    throw new MaterializationValidationError(
      `Telemetry projection run '${run.id}' expected batch ordinal ${checkpoint.nextBatchOrdinal}, got ${batchOrdinal}.`
    )
  }
  if (checkpoint.inputExhausted && batchOrdinal >= checkpoint.nextBatchOrdinal) {
    throw new MaterializationValidationError(
      `Telemetry projection run '${run.id}' has already exhausted its input.`
    )
  }
  if (sourceRowCount > checkpoint.fixedBatchSize) {
    throw new MaterializationValidationError(
      `Telemetry projection run '${run.id}' batch exceeds its fixed size.`
    )
  }
  if (!inputExhausted && sourceRowCount !== checkpoint.fixedBatchSize) {
    throw new MaterializationValidationError(
      `Telemetry projection run '${run.id}' cannot advance past a partial non-final batch.`
    )
  }
}

function assertTelemetryReplayCheckpoint(run: ProjectionRunRecord, batchOrdinal: number): void {
  if (!run.telemetryCheckpoint || batchOrdinal >= run.telemetryCheckpoint.nextBatchOrdinal) {
    throw new MaterializationValidationError(
      `Telemetry commit batch ${batchOrdinal} exists without an advanced run checkpoint.`
    )
  }
}

function telemetryProjectionReplayResult(
  commit: OntologyCommitRecord,
  command: PreparedProjectionTelemetry
): TelemetryCommitResult {
  const origin = commit.origin
  if (
    origin.kind !== "telemetry" ||
    origin.source.kind !== "projection" ||
    origin.source.projectionRunId !== command.source.execution.projectionRunId ||
    origin.source.batchOrdinal !== command.source.batchOrdinal ||
    commit.result.kind !== "telemetry"
  ) {
    throw new MaterializationConflictError(
      "run-correlation",
      `Telemetry commit '${commit.id}' belongs to a different logical run or batch.`
    )
  }
  return { ...structuredClone(commit.result), created: false }
}

async function executeTelemetryCommit(
  context: MaterializerContext,
  command: PreparedTelemetryAppend
): Promise<TelemetryCommitResult> {
  return withSerializationRetry(context, () =>
    context.storage.transaction(
      (storage) => executeTelemetryTransaction(context, storage, command),
      { isolation: "serializable" }
    )
  )
}

async function executeTelemetryTransaction(
  context: MaterializerContext,
  storage: MaterializerStorage,
  command: PreparedTelemetryAppend
): Promise<TelemetryCommitResult> {
  await ensureMaterializerExecution(storage.executions, command.execution)
  const execution = await assertTelemetryExecution(storage, context.projectId, command)
  const replay = await replayCommitRecord(
    context,
    command.identity,
    command.execution.executionId,
    storage
  )
  if (replay) {
    if (command.kind === "projection" && execution) {
      assertTelemetryReplayCheckpoint(execution.run, command.source.batchOrdinal)
      return telemetryProjectionReplayResult(replay, command)
    }
    return { ...structuredClone(replay.result), created: false } as TelemetryCommitResult
  }
  if (command.kind === "projection") {
    if (
      !execution?.run.telemetryCheckpoint ||
      execution.run.telemetryCheckpoint.nextBatchOrdinal !== command.source.batchOrdinal
    ) {
      throw new MaterializationValidationError(
        `Telemetry projection batch ${command.source.batchOrdinal} is behind its run checkpoint.`
      )
    }
  }

  const origin = telemetryOrigin(command)
  const session = await beginTelemetryMaterialization(context, storage, command, origin)
  const counts = await planTelemetryAppend(
    context,
    storage.ontology.materializations,
    session,
    command.input,
    command.identity,
    origin,
    {
      correlationId: command.execution.correlationId,
      ...(command.execution.actor === undefined ? {} : { actor: command.execution.actor }),
    }
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
    committedAt: command.identity.committedAt,
    ...counts,
  }
  return finalizeTelemetryMaterialization(
    storage,
    session,
    command,
    result,
    execution?.projectionRuns
  )
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
    executionId: command.execution.executionId,
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
  if (command.execution.actor === undefined) return commit
  return { ...commit, actor: command.execution.actor }
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
      sourceRowCount: command.source.sourceRowCount,
      sourceRowsSkipped: command.source.sourceRowsSkipped,
      inputExhausted: command.source.inputExhausted,
    },
  }
}

async function finalizeTelemetryMaterialization(
  storage: MaterializerStorage,
  session: MaterializationSession,
  command: PreparedTelemetryAppend,
  result: TelemetryCommitResult,
  projectionRuns: ProjectionRunStorage | undefined
): Promise<TelemetryCommitResult> {
  const applied = await storage.ontology.materializations.finalize({
    session,
    finalization: { sourceActivations: [], result },
  })
  if (command.kind === "projection") {
    if (!projectionRuns) {
      throw new MaterializationValidationError("Expected an asserted telemetry projection run.")
    }
    await projectionRuns.advanceTelemetryCheckpoint({
      id: command.source.execution.projectionRunId,
      projectId: applied.commit.projectId,
      executionToken: command.source.execution.executionToken,
      identity: command.runIdentity,
      batchOrdinal: command.source.batchOrdinal,
      batchRowCount: command.source.sourceRowCount,
      batchRowsSkipped: command.source.sourceRowsSkipped,
      inputExhausted: command.source.inputExhausted,
    })
  }
  return applied.commit.result as TelemetryCommitResult
}
