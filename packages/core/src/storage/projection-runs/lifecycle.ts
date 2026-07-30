import type {
  ProjectionMaterializationIdentity,
  ProjectionRunTerminalDecision,
} from "../../materialization/model"
import type { ProjectionKind, ProjectionTarget } from "../../projections/types"
import { ProjectionRunError } from "./errors"
import type {
  AdvanceProjectionTelemetryCheckpointInput,
  FinishProjectionRunInput,
  ProjectionRunClaim,
  ProjectionRunProgress,
  ProjectionRunRecord,
  ProjectionRunStatus,
  ProjectionTelemetryCheckpoint,
  StartOrReclaimProjectionRunInput,
  TelemetryProjectionRunRecord,
} from "./types"
import { PROJECTION_RUN_PROGRESS_KEYS, zeroProjectionRunProgress } from "./types"

export type StoredProjectionRunRecord = ProjectionRunRecord & {
  readonly executionToken?: string
}

export interface PersistedProjectionRunRecord {
  readonly id: string
  readonly projectId: string
  readonly projectionId: string
  readonly projectionKind: ProjectionKind
  readonly protocol?: "replacement" | "telemetry"
  readonly datasetId: string
  readonly datasetVersionId: string
  readonly datasetVersionCreatedAt?: string
  readonly ontologyRevision?: string
  readonly projectionRevision?: string
  readonly ownershipHash?: string
  readonly objectTypeId?: string
  readonly sourceObjectTypeId?: string
  readonly targetObjectTypeId?: string
  readonly status: ProjectionRunStatus
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly attempt: number
  readonly executionToken?: string
  readonly fixedBatchSize?: number
  readonly nextBatchOrdinal?: number
  readonly nextRowOffset?: number
  readonly inputExhausted?: boolean
  readonly progress: ProjectionRunProgress
  readonly errorMessage?: string
}

export interface ProjectionTelemetryAdvance {
  readonly progress: ProjectionRunProgress
  readonly checkpoint: ProjectionTelemetryCheckpoint
}

export interface ProjectionRunFinishPlan {
  readonly status: Exclude<ProjectionRunStatus, "running">
  readonly finishedAt: Date
  readonly progress: ProjectionRunProgress
  readonly inputExhausted?: true
  readonly errorMessage?: string
}

// ── Scalar and identity validation ──────────────────────────

export function assertProjectionRunNonEmpty(value: string, fieldName: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectionRunError(`[Sixb] Projection run ${fieldName} must not be empty.`)
  }
}

export function assertProjectionRunCounter(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProjectionRunError(
      `[Sixb] Projection run ${fieldName} must be a non-negative safe integer.`
    )
  }
}

export function assertProjectionRunListWindow(value: number | undefined, fieldName: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ProjectionRunError(`[Sixb] Projection run list ${fieldName} must be >= 0.`)
  }
}

export function addProjectionRunCounter(left: number, right: number, fieldName: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) {
    throw new ProjectionRunError(`[Sixb] Projection run ${fieldName} exceeds safe integer range.`)
  }
  return result
}

export function assertProjectionRunIdentity(identity: ProjectionMaterializationIdentity): void {
  assertProjectionRunNonEmpty(identity.projectionId, "projectionId")
  if (!isProjectionKind(identity.projectionKind)) {
    throw new ProjectionRunError(
      "[Sixb] Projection run projectionKind must be 'object', 'link', or 'telemetry'."
    )
  }
  if (identity.protocol !== "replacement" && identity.protocol !== "telemetry") {
    throw new ProjectionRunError(
      "[Sixb] Projection run protocol must be 'replacement' or 'telemetry'."
    )
  }
  assertProjectionRunNonEmpty(identity.datasetVersion.datasetId, "datasetId")
  assertProjectionRunNonEmpty(identity.datasetVersion.versionId, "datasetVersionId")
  assertCanonicalTimestamp(identity.datasetVersion.createdAt, "datasetVersionCreatedAt")
  assertProjectionRunNonEmpty(identity.ontologyRevision, "ontologyRevision")
  assertProjectionRunNonEmpty(identity.projectionRevision, "projectionRevision")
  assertProjectionRunNonEmpty(identity.ownershipHash, "ownershipHash")
  if ((identity.protocol === "telemetry") !== (identity.projectionKind === "telemetry")) {
    throw new ProjectionRunError(
      `[Sixb] Projection run protocol '${identity.protocol}' is incompatible with kind '${identity.projectionKind}'.`
    )
  }
}

export function assertProjectionRunIdentityMatches(
  record: Pick<ProjectionRunRecord, "id" | "identity">,
  identity: ProjectionMaterializationIdentity
): void {
  if (projectionRunIdentitiesEqual(record.identity, identity)) return
  throw new ProjectionRunError(
    `[Sixb] Projection run '${record.id}' materialization identity does not match.`
  )
}

export function assertProjectionRunTargetMatches(
  record: Pick<ProjectionRunRecord, "id" | "target">,
  target: ProjectionTarget
): void {
  if (projectionTargetsEqual(record.target, target)) return
  throw new ProjectionRunError(
    `[Sixb] Projection run '${record.id}' target object types do not match.`
  )
}

export function assertProjectionRunStartInput(input: StartOrReclaimProjectionRunInput): void {
  assertProjectionRunNonEmpty(input.id, "id")
  assertProjectionRunNonEmpty(input.projectId, "projectId")
  assertProjectionRunIdentity(input.identity)
  assertProjectionTarget(input.identity.projectionKind, input.target)
  if (input.startedAt) assertProjectionRunDate(input.startedAt, "startedAt")
  if (input.identity.projectionKind === "telemetry") {
    const telemetry = input as ProjectionRunStart<"telemetry">
    assertPositiveCounter(telemetry.fixedBatchSize, "fixedBatchSize")
  } else if (input.fixedBatchSize !== undefined) {
    throw new ProjectionRunError(
      "[Sixb] Replacement projection runs cannot declare a telemetry fixedBatchSize."
    )
  }
}

export function planProjectionRunReclaim(
  record: StoredProjectionRunRecord,
  input: StartOrReclaimProjectionRunInput
): { readonly attempt: number } {
  assertProjectionRunRunning(record)
  assertProjectionRunIdentityMatches(record, input.identity)
  assertProjectionRunTargetMatches(record, input.target)
  if (record.telemetryCheckpoint?.fixedBatchSize !== input.fixedBatchSize) {
    throw new ProjectionRunError(
      `[Sixb] Projection run '${input.id}' fixed batch size does not match.`
    )
  }
  return { attempt: nextProjectionRunAttempt(record.attempt) }
}

// ── Lifecycle transitions ───────────────────────────────────

export function createProjectionRunRecord(
  input: StartOrReclaimProjectionRunInput,
  now: Date = new Date()
): ProjectionRunRecord {
  assertProjectionRunStartInput(input)
  const base = {
    id: input.id,
    projectId: input.projectId,
    status: "running" as const,
    attempt: 1,
    progress: zeroProjectionRunProgress(),
    startedAt: new Date(input.startedAt ?? now),
  }
  switch (input.identity.projectionKind) {
    case "object": {
      const object = input as ProjectionRunStart<"object">
      return { ...base, identity: object.identity, target: object.target }
    }
    case "link": {
      const link = input as ProjectionRunStart<"link">
      return { ...base, identity: link.identity, target: link.target }
    }
    case "telemetry": {
      const telemetry = input as ProjectionRunStart<"telemetry">
      return {
        ...base,
        identity: telemetry.identity,
        target: telemetry.target,
        telemetryCheckpoint: {
          fixedBatchSize: telemetry.fixedBatchSize,
          nextBatchOrdinal: 0,
          nextRowOffset: 0,
          inputExhausted: false,
        },
      }
    }
  }
}

export function assertProjectionRunRunning(
  record: Pick<ProjectionRunRecord, "id" | "projectId" | "status">
): void {
  if (record.status === "running") return
  throw new ProjectionRunError(
    `[Sixb] Projection run '${record.id}' for project '${record.projectId}' is already terminal.`
  )
}

export function assertProjectionRunExecution(
  record: StoredProjectionRunRecord,
  input: {
    readonly id: string
    readonly executionToken: string
    readonly identity: ProjectionMaterializationIdentity
  }
): asserts record is StoredProjectionRunRecord & { readonly executionToken: string } {
  assertProjectionRunNonEmpty(input.executionToken, "executionToken")
  assertProjectionRunIdentity(input.identity)
  assertProjectionRunRunning(record)
  assertProjectionRunIdentityMatches(record, input.identity)
  if (record.executionToken !== input.executionToken) {
    throw staleProjectionRunExecution(input.id)
  }
}

export function nextProjectionRunAttempt(current: number): number {
  assertProjectionRunCounter(current, "attempt")
  return addProjectionRunCounter(current, 1, "attempt")
}

export function mergeProjectionRunProgress(
  current: ProjectionRunProgress,
  patch: Partial<ProjectionRunProgress>
): ProjectionRunProgress {
  const progress = { ...current }
  for (const key of PROJECTION_RUN_PROGRESS_KEYS) {
    const value = patch[key]
    if (value === undefined) continue
    assertProjectionRunCounter(value, key)
    if (value < current[key]) {
      throw new ProjectionRunError(`[Sixb] Projection run ${key} must not decrease.`)
    }
    progress[key] = value
  }
  assertProjectionRunProgress(progress)
  return progress
}

export function assertGenericProgressDoesNotAdvanceTelemetry(
  record: Pick<ProjectionRunRecord, "id" | "identity" | "progress">,
  patch: Partial<ProjectionRunProgress>
): void {
  if (record.identity.protocol !== "telemetry") return
  for (const key of PROJECTION_RUN_PROGRESS_KEYS) {
    if (patch[key] !== undefined && patch[key] !== record.progress[key]) {
      throw new ProjectionRunError(
        `[Sixb] Telemetry projection run '${record.id}' progress can only advance with its checkpoint.`
      )
    }
  }
}

export function advanceProjectionTelemetry(
  record: ProjectionRunRecord,
  input: AdvanceProjectionTelemetryCheckpointInput
): ProjectionTelemetryAdvance {
  const telemetry = requireTelemetryProjectionRun(record)
  const checkpoint = telemetry.telemetryCheckpoint
  assertProjectionRunCounter(input.batchOrdinal, "batchOrdinal")
  assertPositiveCounter(input.batchRowCount, "batchRowCount")
  assertProjectionRunCounter(input.batchRowsSkipped, "batchRowsSkipped")
  if (input.batchRowsSkipped > input.batchRowCount) {
    throw new ProjectionRunError(
      `[Sixb] Telemetry projection run '${record.id}' skipped rows exceed its batch row count.`
    )
  }
  if (input.batchOrdinal !== checkpoint.nextBatchOrdinal) {
    throw new ProjectionRunError(
      `[Sixb] Telemetry projection run '${record.id}' expected batch ordinal ${checkpoint.nextBatchOrdinal}, got ${input.batchOrdinal}.`
    )
  }
  if (input.batchRowCount > checkpoint.fixedBatchSize) {
    throw new ProjectionRunError(
      `[Sixb] Telemetry projection run '${record.id}' batch exceeds its fixed size.`
    )
  }
  if (!input.inputExhausted && input.batchRowCount !== checkpoint.fixedBatchSize) {
    throw new ProjectionRunError(
      `[Sixb] Telemetry projection run '${record.id}' cannot advance past a partial non-final batch.`
    )
  }
  if (checkpoint.inputExhausted) {
    throw new ProjectionRunError(
      `[Sixb] Telemetry projection run '${record.id}' has already exhausted its input.`
    )
  }

  const nextRowOffset = addProjectionRunCounter(
    checkpoint.nextRowOffset,
    input.batchRowCount,
    "nextRowOffset"
  )
  return {
    progress: {
      sourceRowsRead: nextRowOffset,
      sourceRowsSkipped: addProjectionRunCounter(
        telemetry.progress.sourceRowsSkipped,
        input.batchRowsSkipped,
        "sourceRowsSkipped"
      ),
    },
    checkpoint: {
      ...checkpoint,
      nextBatchOrdinal: addProjectionRunCounter(checkpoint.nextBatchOrdinal, 1, "nextBatchOrdinal"),
      nextRowOffset,
      inputExhausted: input.inputExhausted,
    },
  }
}

export function planProjectionRunFinish(
  record: ProjectionRunRecord,
  input: FinishProjectionRunInput,
  now: Date = new Date()
): ProjectionRunFinishPlan {
  assertFinishDecision(record, input)
  const patch = input.progress ?? {}
  assertGenericProgressDoesNotAdvanceTelemetry(record, patch)
  const progress = mergeProjectionRunProgress(record.progress, patch)
  const finishedAt = new Date(input.finishedAt ?? now)
  assertProjectionRunDate(finishedAt, "finishedAt")
  return {
    status: input.status,
    finishedAt,
    progress,
    ...(input.status === "succeeded" && input.protocol === "telemetry"
      ? { inputExhausted: true as const }
      : {}),
    ...(input.status === "succeeded" || input.errorMessage === undefined
      ? {}
      : { errorMessage: input.errorMessage }),
  }
}

export function finishProjectionRunRecord(
  record: StoredProjectionRunRecord,
  input: FinishProjectionRunInput,
  now: Date = new Date()
): StoredProjectionRunRecord {
  const plan = planProjectionRunFinish(record, input, now)
  const terminal = {
    executionToken: undefined,
    status: plan.status,
    finishedAt: plan.finishedAt,
    progress: plan.progress,
    errorMessage: plan.errorMessage,
  }
  if (plan.inputExhausted) {
    const telemetry = requireTelemetryProjectionRun(record)
    return {
      ...telemetry,
      ...terminal,
      telemetryCheckpoint: { ...telemetry.telemetryCheckpoint, inputExhausted: true },
    }
  }
  return { ...record, ...terminal }
}

// ── Persistence mapping ─────────────────────────────────────

export function restoreProjectionRun(row: PersistedProjectionRunRecord): StoredProjectionRunRecord {
  assertProjectionRunNonEmpty(row.id, "id")
  assertProjectionRunNonEmpty(row.projectId, "projectId")
  assertProjectionRunCounter(row.attempt, "attempt")
  if (row.attempt < 1) {
    throw new ProjectionRunError(`[Sixb] Projection run '${row.id}' attempt must be positive.`)
  }
  assertProjectionRunProgress(row.progress)
  assertValidDate(row.startedAt, "startedAt")
  if (row.finishedAt) assertValidDate(row.finishedAt, "finishedAt")
  if ((row.status === "running") !== (row.finishedAt === undefined)) {
    throw incompleteProjectionRun(row.id)
  }
  if ((row.status === "running") !== (row.executionToken !== undefined)) {
    throw incompleteProjectionRun(row.id)
  }

  const identity = restoreIdentity(row)
  const base = {
    id: row.id,
    projectId: row.projectId,
    identity,
    status: row.status,
    startedAt: new Date(row.startedAt),
    finishedAt: row.finishedAt ? new Date(row.finishedAt) : undefined,
    attempt: row.attempt,
    progress: { ...row.progress },
    errorMessage: row.errorMessage,
    executionToken: row.executionToken,
  }

  if (identity.projectionKind === "link") {
    if (!row.sourceObjectTypeId || !row.targetObjectTypeId || row.objectTypeId) {
      throw invalidProjectionRunTarget(row.id)
    }
    assertNoCheckpoint(row)
    return {
      ...base,
      identity,
      target: {
        sourceObjectTypeId: row.sourceObjectTypeId,
        targetObjectTypeId: row.targetObjectTypeId,
      },
    }
  }
  if (!row.objectTypeId || row.sourceObjectTypeId || row.targetObjectTypeId) {
    throw invalidProjectionRunTarget(row.id)
  }
  if (identity.projectionKind === "telemetry") {
    const telemetryCheckpoint = restoreCheckpoint(row)
    if (row.progress.sourceRowsRead !== telemetryCheckpoint.nextRowOffset) {
      throw new ProjectionRunError(
        `[Sixb] Telemetry projection run '${row.id}' progress does not match its checkpoint.`
      )
    }
    if (row.status === "succeeded" && !telemetryCheckpoint.inputExhausted) {
      throw incompleteProjectionRun(row.id)
    }
    return {
      ...base,
      identity,
      target: { objectTypeId: row.objectTypeId },
      telemetryCheckpoint,
    }
  }
  assertNoCheckpoint(row)
  return { ...base, identity, target: { objectTypeId: row.objectTypeId } }
}

export function publicProjectionRunRecord(record: StoredProjectionRunRecord): ProjectionRunRecord {
  const cloned = structuredClone(record)
  Reflect.deleteProperty(cloned, "executionToken")
  return cloned
}

export function createProjectionRunClaim(record: StoredProjectionRunRecord): ProjectionRunClaim {
  assertProjectionRunRunning(record)
  const executionToken = requireProjectionRunExecutionToken(record)
  return {
    run: publicProjectionRunRecord(record),
    execution: { projectionRunId: record.id, executionToken },
  }
}

export function requireProjectionRunExecutionToken(record: StoredProjectionRunRecord): string {
  if (record.executionToken) return record.executionToken
  throw incompleteProjectionRun(record.id)
}

export function staleProjectionRunExecution(id: string): ProjectionRunError {
  return new ProjectionRunError(
    `[Sixb] Projection run '${id}' execution token is stale.`,
    "execution-lost"
  )
}

export function projectionRunNotFound(projectId: string, id: string): ProjectionRunError {
  return new ProjectionRunError(
    `[Sixb] Projection run '${id}' not found for project '${projectId}'.`
  )
}

export function immutableDatasetVersionConflict(
  identity: ProjectionMaterializationIdentity
): ProjectionRunError {
  return new ProjectionRunError(
    `[Sixb] Dataset version '${identity.datasetVersion.versionId}' reused an immutable dataset version id with different metadata.`
  )
}

// ── Private helpers ─────────────────────────────────────────

function assertPositiveCounter(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProjectionRunError(
      `[Sixb] Projection run ${fieldName} must be a positive safe integer.`
    )
  }
}

function assertCanonicalTimestamp(value: string, fieldName: string): void {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new ProjectionRunError(
      `[Sixb] Projection run ${fieldName} must be a canonical UTC timestamp.`
    )
  }
}

function assertValidDate(value: Date, fieldName: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new ProjectionRunError(`[Sixb] Projection run persisted ${fieldName} is invalid.`)
  }
}

function assertProjectionRunDate(value: Date, fieldName: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new ProjectionRunError(`[Sixb] Projection run ${fieldName} is invalid.`)
  }
}

function isProjectionKind(value: unknown): value is ProjectionKind {
  return value === "object" || value === "link" || value === "telemetry"
}

function assertProjectionTarget(kind: ProjectionKind, target: ProjectionTarget): void {
  if (kind === "link") {
    if (!("sourceObjectTypeId" in target)) {
      throw new ProjectionRunError(
        "[Sixb] Link projection runs must declare source and target object types."
      )
    }
    assertProjectionRunNonEmpty(target.sourceObjectTypeId, "sourceObjectTypeId")
    assertProjectionRunNonEmpty(target.targetObjectTypeId, "targetObjectTypeId")
    return
  }
  if (!("objectTypeId" in target)) {
    throw new ProjectionRunError(
      "[Sixb] Object and telemetry projection runs must declare one object type."
    )
  }
  assertProjectionRunNonEmpty(target.objectTypeId, "objectTypeId")
}

function projectionRunIdentitiesEqual(
  left: ProjectionMaterializationIdentity,
  right: ProjectionMaterializationIdentity
): boolean {
  return (
    left.projectionId === right.projectionId &&
    left.projectionKind === right.projectionKind &&
    left.protocol === right.protocol &&
    left.datasetVersion.datasetId === right.datasetVersion.datasetId &&
    left.datasetVersion.versionId === right.datasetVersion.versionId &&
    left.datasetVersion.createdAt === right.datasetVersion.createdAt &&
    left.ontologyRevision === right.ontologyRevision &&
    left.projectionRevision === right.projectionRevision &&
    left.ownershipHash === right.ownershipHash
  )
}

function projectionTargetsEqual(left: ProjectionTarget, right: ProjectionTarget): boolean {
  if ("sourceObjectTypeId" in left || "sourceObjectTypeId" in right) {
    return (
      "sourceObjectTypeId" in left &&
      "sourceObjectTypeId" in right &&
      left.sourceObjectTypeId === right.sourceObjectTypeId &&
      left.targetObjectTypeId === right.targetObjectTypeId
    )
  }
  return left.objectTypeId === right.objectTypeId
}

function assertProjectionRunProgress(progress: ProjectionRunProgress): void {
  for (const key of PROJECTION_RUN_PROGRESS_KEYS) {
    assertProjectionRunCounter(progress[key], key)
  }
  if (progress.sourceRowsSkipped > progress.sourceRowsRead) {
    throw new ProjectionRunError(
      "[Sixb] Projection run sourceRowsSkipped must not exceed sourceRowsRead."
    )
  }
}

function assertFinishDecision(
  record: ProjectionRunRecord,
  input: ProjectionRunTerminalDecision
): void {
  if (input.status !== "succeeded" && input.status !== "failed" && input.status !== "cancelled") {
    throw new ProjectionRunError(
      `[Sixb] Projection run '${record.id}' finish status must be terminal.`
    )
  }
  if (input.protocol !== "replacement" && input.protocol !== "telemetry") {
    throw new ProjectionRunError(`[Sixb] Projection run '${record.id}' finish protocol is invalid.`)
  }
  if (input.protocol !== record.identity.protocol) {
    throw new ProjectionRunError(
      `[Sixb] Projection run '${record.id}' finish protocol does not match its identity.`
    )
  }
  const inputExhausted = "inputExhausted" in input ? input.inputExhausted : undefined
  if (input.status === "succeeded" && input.protocol === "telemetry") {
    if (inputExhausted === true) return
    throw new ProjectionRunError(
      `[Sixb] Telemetry projection run '${record.id}' cannot succeed before input exhaustion.`
    )
  }
  if (inputExhausted !== undefined) {
    throw new ProjectionRunError(
      `[Sixb] Projection run '${record.id}' contains telemetry-only completion metadata.`
    )
  }
}

function restoreIdentity(row: PersistedProjectionRunRecord): ProjectionMaterializationIdentity {
  if (
    !row.protocol ||
    !row.datasetVersionCreatedAt ||
    !row.ontologyRevision ||
    !row.projectionRevision ||
    !row.ownershipHash
  ) {
    throw incompleteProjectionRun(row.id)
  }
  const identity = {
    projectionId: row.projectionId,
    projectionKind: row.projectionKind,
    protocol: row.protocol,
    datasetVersion: {
      datasetId: row.datasetId,
      versionId: row.datasetVersionId,
      createdAt: row.datasetVersionCreatedAt,
    },
    ontologyRevision: row.ontologyRevision,
    projectionRevision: row.projectionRevision,
    ownershipHash: row.ownershipHash,
  } as ProjectionMaterializationIdentity
  assertProjectionRunIdentity(identity)
  return identity
}

function restoreCheckpoint(row: PersistedProjectionRunRecord): ProjectionTelemetryCheckpoint {
  if (
    row.fixedBatchSize === undefined ||
    row.nextBatchOrdinal === undefined ||
    row.nextRowOffset === undefined ||
    row.inputExhausted === undefined
  ) {
    throw new ProjectionRunError(
      `[Sixb] Telemetry projection run '${row.id}' has incomplete checkpoint state.`
    )
  }
  assertPositiveCounter(row.fixedBatchSize, "fixedBatchSize")
  assertProjectionRunCounter(row.nextBatchOrdinal, "nextBatchOrdinal")
  assertProjectionRunCounter(row.nextRowOffset, "nextRowOffset")
  return {
    fixedBatchSize: row.fixedBatchSize,
    nextBatchOrdinal: row.nextBatchOrdinal,
    nextRowOffset: row.nextRowOffset,
    inputExhausted: row.inputExhausted,
  }
}

function assertNoCheckpoint(row: PersistedProjectionRunRecord): void {
  if (
    row.fixedBatchSize === undefined &&
    row.nextBatchOrdinal === undefined &&
    row.nextRowOffset === undefined &&
    row.inputExhausted === undefined
  ) {
    return
  }
  throw new ProjectionRunError(
    `[Sixb] Replacement projection run '${row.id}' contains a telemetry checkpoint.`
  )
}

function incompleteProjectionRun(id: string): ProjectionRunError {
  return new ProjectionRunError(
    `[Sixb] Projection run '${id}' has incomplete materialization state.`
  )
}

function invalidProjectionRunTarget(id: string): ProjectionRunError {
  return new ProjectionRunError(`[Sixb] Projection run '${id}' has an invalid target.`)
}

export function requireTelemetryProjectionRun<TRecord extends ProjectionRunRecord>(
  record: TRecord
): TRecord & TelemetryProjectionRunRecord {
  if (isTelemetryProjectionRun(record)) return record as TRecord & TelemetryProjectionRunRecord
  throw new ProjectionRunError(
    `[Sixb] Projection run '${record.id}' does not have a telemetry checkpoint.`
  )
}

type ProjectionRunStart<TKind extends ProjectionKind> = Extract<
  StartOrReclaimProjectionRunInput,
  { readonly identity: { readonly projectionKind: TKind } }
>

function isTelemetryProjectionRun(
  record: ProjectionRunRecord
): record is TelemetryProjectionRunRecord {
  return record.identity.projectionKind === "telemetry"
}
