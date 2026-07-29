import { randomUUID } from "node:crypto"
import type { ProjectionMaterializationIdentity } from "../../materialization/model"
import type { AssertSourceMaterializationExecutionInput } from "../ontology/sources"
import { latestStartedAtByOwnerId } from "../run-listing"
import { ProjectionRunError } from "./errors"
import {
  type AdvanceProjectionTelemetryCheckpointInput,
  type FinishProjectionRunInput,
  type ListLatestProjectionRunsInput,
  type ListLatestProjectionRunsResult,
  type ListProjectionRunsInput,
  type ListProjectionRunsResult,
  type LockProjectionRunForMaterializationInput,
  PROJECTION_RUN_PROGRESS_KEYS,
  type ProjectionRunClaim,
  type ProjectionRunProgress,
  type ProjectionRunRecord,
  type ProjectionRunStorage,
  projectionRunObjectTypesVisible,
  type StartOrReclaimProjectionRunInput,
  type TelemetryProjectionRunRecord,
  type UpdateProjectionRunInput,
  zeroProjectionRunProgress,
} from "./types"

type RunRootOperation = <T>(run: () => Promise<T> | T) => Promise<T>
type StoredProjectionRunRecord = ProjectionRunRecord & { readonly executionToken?: string }

const runDirectly: RunRootOperation = async <T>(run: () => Promise<T> | T): Promise<T> => run()

function projectionRunKey(projectId: string, id: string): string {
  return JSON.stringify([projectId, id])
}

function publicRecord(record: StoredProjectionRunRecord): ProjectionRunRecord {
  const cloned = structuredClone(record)
  Reflect.deleteProperty(cloned, "executionToken")
  return cloned
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectionRunError(`[Sixb] Projection run ${fieldName} must not be empty.`)
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

function assertCounter(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProjectionRunError(
      `[Sixb] Projection run ${fieldName} must be a non-negative safe integer.`
    )
  }
}

function assertPositiveCounter(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProjectionRunError(
      `[Sixb] Projection run ${fieldName} must be a positive safe integer.`
    )
  }
}

function assertOptionalWindowValue(value: number | undefined, fieldName: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ProjectionRunError(`[Sixb] Projection run list ${fieldName} must be >= 0.`)
  }
}

function safeAdd(left: number, right: number, fieldName: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) {
    throw new ProjectionRunError(`[Sixb] Projection run ${fieldName} exceeds safe integer range.`)
  }
  return result
}

function assertIdentity(identity: ProjectionMaterializationIdentity): void {
  assertNonEmpty(identity.projectionId, "projectionId")
  assertNonEmpty(identity.datasetVersion.datasetId, "datasetId")
  assertNonEmpty(identity.datasetVersion.versionId, "datasetVersionId")
  assertCanonicalTimestamp(identity.datasetVersion.createdAt, "datasetVersionCreatedAt")
  assertNonEmpty(identity.ontologyRevision, "ontologyRevision")
  assertNonEmpty(identity.projectionRevision, "projectionRevision")
  assertNonEmpty(identity.ownershipHash, "ownershipHash")
  if ((identity.protocol === "telemetry") !== (identity.projectionKind === "telemetry")) {
    throw new ProjectionRunError(
      `[Sixb] Projection run protocol '${identity.protocol}' is incompatible with kind '${identity.projectionKind}'.`
    )
  }
}

function identitiesEqual(
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

function assertIdentityMatches(
  record: ProjectionRunRecord,
  identity: ProjectionMaterializationIdentity
): void {
  if (identitiesEqual(record.identity, identity)) return
  throw new ProjectionRunError(
    `[Sixb] Projection run '${record.id}' materialization identity does not match.`
  )
}

function targetsEqual(
  left: ProjectionRunRecord["target"],
  right: StartOrReclaimProjectionRunInput["target"]
): boolean {
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

function assertTargetMatches(
  record: ProjectionRunRecord,
  input: StartOrReclaimProjectionRunInput
): void {
  if (targetsEqual(record.target, input.target)) return
  throw new ProjectionRunError(
    `[Sixb] Projection run '${record.id}' target object types do not match.`
  )
}

function assertStartInput(input: StartOrReclaimProjectionRunInput): void {
  assertNonEmpty(input.id, "id")
  assertNonEmpty(input.projectId, "projectId")
  assertIdentity(input.identity)
  if ("sourceObjectTypeId" in input.target) {
    assertNonEmpty(input.target.sourceObjectTypeId, "sourceObjectTypeId")
    assertNonEmpty(input.target.targetObjectTypeId, "targetObjectTypeId")
  } else {
    assertNonEmpty(input.target.objectTypeId, "objectTypeId")
  }
  if (input.identity.projectionKind === "telemetry") {
    assertPositiveCounter(input.fixedBatchSize ?? 0, "fixedBatchSize")
  } else if (input.fixedBatchSize !== undefined) {
    throw new ProjectionRunError(
      "[Sixb] Replacement projection runs cannot declare a telemetry fixedBatchSize."
    )
  }
}

function createRunRecord(input: StartOrReclaimProjectionRunInput): ProjectionRunRecord {
  const base = {
    id: input.id,
    projectId: input.projectId,
    status: "running" as const,
    attempt: 1,
    progress: zeroProjectionRunProgress(),
    startedAt: new Date(input.startedAt ?? new Date()),
  }
  switch (input.identity.projectionKind) {
    case "object": {
      const typed = input as Extract<
        StartOrReclaimProjectionRunInput,
        { readonly identity: { readonly projectionKind: "object" } }
      >
      return { ...base, identity: typed.identity, target: typed.target }
    }
    case "link": {
      const typed = input as Extract<
        StartOrReclaimProjectionRunInput,
        { readonly identity: { readonly projectionKind: "link" } }
      >
      return { ...base, identity: typed.identity, target: typed.target }
    }
    case "telemetry": {
      const typed = input as Extract<
        StartOrReclaimProjectionRunInput,
        { readonly identity: { readonly projectionKind: "telemetry" } }
      >
      return {
        ...base,
        identity: typed.identity,
        target: typed.target,
        telemetryCheckpoint: {
          fixedBatchSize: typed.fixedBatchSize,
          nextBatchOrdinal: 0,
          nextRowOffset: 0,
          inputExhausted: false,
        },
      }
    }
  }
}

function applyProgress<TRecord extends ProjectionRunRecord>(
  record: TRecord,
  patch: Partial<ProjectionRunProgress>
): TRecord {
  const progress = { ...record.progress }
  for (const key of PROJECTION_RUN_PROGRESS_KEYS) {
    const value = patch[key]
    if (value === undefined) continue
    assertCounter(value, key)
    if (value < record.progress[key]) {
      throw new ProjectionRunError(`[Sixb] Projection run ${key} must not decrease.`)
    }
    progress[key] = value
  }
  if (progress.sourceRowsSkipped > progress.sourceRowsRead) {
    throw new ProjectionRunError(
      "[Sixb] Projection run sourceRowsSkipped must not exceed sourceRowsRead."
    )
  }
  return { ...record, progress }
}

function assertGenericProgressDoesNotAdvanceTelemetry(
  record: ProjectionRunRecord,
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

function compareRuns(a: ProjectionRunRecord, b: ProjectionRunRecord, order: "asc" | "desc") {
  const delta = a.startedAt.getTime() - b.startedAt.getTime()
  if (delta !== 0) return order === "asc" ? delta : -delta
  if (a.id === b.id) return 0
  return order === "asc" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)
}

function finishRecord(
  record: StoredProjectionRunRecord,
  input: FinishProjectionRunInput
): StoredProjectionRunRecord {
  const terminal = {
    executionToken: undefined,
    status: input.status,
    finishedAt: new Date(input.finishedAt ?? new Date()),
    errorMessage: input.status === "succeeded" ? undefined : input.errorMessage,
  }
  if (input.status === "succeeded" && record.telemetryCheckpoint) {
    return {
      ...(record as TelemetryProjectionRunRecord),
      ...terminal,
      telemetryCheckpoint: { ...record.telemetryCheckpoint, inputExhausted: true },
    }
  }
  return { ...record, ...terminal }
}

export class InMemoryProjectionRunStorage implements ProjectionRunStorage {
  private readonly rows = new Map<string, StoredProjectionRunRecord>()
  /** Durable per-run history prevents a reclaimed execution token from becoming valid again. */
  private readonly executionTokensByRun = new Map<string, Set<string>>()
  private readonly runRootOperation: RunRootOperation
  private readonly createExecutionToken: () => string

  constructor(
    input: {
      readonly runRootOperation?: RunRootOperation
      readonly executionToken?: () => string
    } = {}
  ) {
    this.runRootOperation = input.runRootOperation ?? runDirectly
    this.createExecutionToken = input.executionToken ?? randomUUID
  }

  snapshot(): InMemoryProjectionRunStorageSnapshot {
    return structuredClone({
      rows: this.rows,
      executionTokensByRun: this.executionTokensByRun,
    })
  }

  restore(snapshot: InMemoryProjectionRunStorageSnapshot): void {
    this.rows.clear()
    this.executionTokensByRun.clear()
    for (const [key, record] of structuredClone(snapshot.rows)) this.rows.set(key, record)
    for (const [key, tokens] of structuredClone(snapshot.executionTokensByRun)) {
      this.executionTokensByRun.set(key, tokens)
    }
  }

  async startOrReclaim(input: StartOrReclaimProjectionRunInput): Promise<ProjectionRunClaim> {
    return this.runRootOperation(() => {
      assertStartInput(input)
      this.assertDatasetVersionIsImmutable(input)

      const key = projectionRunKey(input.projectId, input.id)
      const existing = this.rows.get(key)
      if (existing) {
        this.assertRunning(existing)
        assertIdentityMatches(existing, input.identity)
        assertTargetMatches(existing, input)
        const expectedBatchSize = existing.telemetryCheckpoint?.fixedBatchSize
        if (expectedBatchSize !== input.fixedBatchSize) {
          throw new ProjectionRunError(
            `[Sixb] Projection run '${input.id}' fixed batch size does not match.`
          )
        }
      }

      const attempt = safeAdd(existing?.attempt ?? 0, 1, "attempt")
      const executionToken = this.issueExecutionToken(key, input.id, existing?.executionToken)
      const record: StoredProjectionRunRecord = existing
        ? { ...existing, attempt, executionToken }
        : { ...createRunRecord(input), executionToken }

      this.rows.set(key, structuredClone(record))
      return {
        run: publicRecord(record),
        execution: { projectionRunId: input.id, executionToken },
      }
    })
  }

  async lockForMaterialization(
    input: LockProjectionRunForMaterializationInput
  ): Promise<ProjectionRunRecord> {
    return this.runRootOperation(() => publicRecord(this.requireExecution(input)))
  }

  /** @internal The caller must already hold InMemoryStorage's root operation lock. */
  assertSourceMaterializationExecutionUnlocked(
    input: AssertSourceMaterializationExecutionInput
  ): void {
    assertNonEmpty(input.source.projectionId, "projectionId")
    assertNonEmpty(input.execution.executionToken, "executionToken")
    const record = this.requireRunning(input.projectId, input.execution.projectionRunId)
    if (
      record.identity.projectionId !== input.source.projectionId ||
      record.identity.protocol !== "replacement"
    ) {
      throw new ProjectionRunError(
        `[Sixb] Projection run '${record.id}' does not own replacement source '${input.source.projectionId}'.`
      )
    }
    if (record.executionToken !== input.execution.executionToken) {
      throw new ProjectionRunError(
        `[Sixb] Projection run '${record.id}' execution token is stale.`,
        "execution-lost"
      )
    }
    if (input.identity) {
      assertIdentityMatches(record, { projectionId: input.source.projectionId, ...input.identity })
    }
  }

  async update(input: UpdateProjectionRunInput): Promise<ProjectionRunRecord> {
    return this.runRootOperation(() => {
      const existing = this.requireExecution(input)
      assertGenericProgressDoesNotAdvanceTelemetry(existing, input.progress)
      const next = applyProgress(existing, input.progress)
      this.rows.set(projectionRunKey(input.projectId, input.id), structuredClone(next))
      return publicRecord(next)
    })
  }

  async advanceTelemetryCheckpoint(
    input: AdvanceProjectionTelemetryCheckpointInput
  ): Promise<TelemetryProjectionRunRecord> {
    return this.runRootOperation(() => {
      const existing = this.requireTelemetryExecution(input)
      const checkpoint = existing.telemetryCheckpoint
      assertCounter(input.batchOrdinal, "batchOrdinal")
      assertPositiveCounter(input.batchRowCount, "batchRowCount")
      assertCounter(input.batchRowsSkipped, "batchRowsSkipped")
      if (input.batchRowsSkipped > input.batchRowCount) {
        throw new ProjectionRunError(
          `[Sixb] Telemetry projection run '${existing.id}' skipped rows exceed its batch row count.`
        )
      }
      if (input.batchOrdinal !== checkpoint.nextBatchOrdinal) {
        throw new ProjectionRunError(
          `[Sixb] Telemetry projection run '${existing.id}' expected batch ordinal ${checkpoint.nextBatchOrdinal}, got ${input.batchOrdinal}.`
        )
      }
      if (input.batchRowCount > checkpoint.fixedBatchSize) {
        throw new ProjectionRunError(
          `[Sixb] Telemetry projection run '${existing.id}' batch exceeds its fixed size.`
        )
      }
      if (!input.inputExhausted && input.batchRowCount !== checkpoint.fixedBatchSize) {
        throw new ProjectionRunError(
          `[Sixb] Telemetry projection run '${existing.id}' cannot advance past a partial non-final batch.`
        )
      }
      if (checkpoint.inputExhausted) {
        throw new ProjectionRunError(
          `[Sixb] Telemetry projection run '${existing.id}' has already exhausted its input.`
        )
      }

      const nextRowOffset = safeAdd(checkpoint.nextRowOffset, input.batchRowCount, "nextRowOffset")
      const next: TelemetryProjectionRunRecord & { readonly executionToken: string } = {
        ...existing,
        progress: {
          sourceRowsRead: nextRowOffset,
          sourceRowsSkipped: safeAdd(
            existing.progress.sourceRowsSkipped,
            input.batchRowsSkipped,
            "sourceRowsSkipped"
          ),
        },
        telemetryCheckpoint: {
          ...checkpoint,
          nextBatchOrdinal: safeAdd(checkpoint.nextBatchOrdinal, 1, "nextBatchOrdinal"),
          nextRowOffset,
          inputExhausted: input.inputExhausted,
        },
      }
      this.rows.set(projectionRunKey(input.projectId, input.id), structuredClone(next))
      return publicRecord(next) as TelemetryProjectionRunRecord
    })
  }

  async finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord> {
    return this.runRootOperation(() => {
      const existing = this.requireExecution(input)
      const patch = input.progress ?? {}
      assertGenericProgressDoesNotAdvanceTelemetry(existing, patch)
      const withProgress = applyProgress(existing, patch)
      const next = finishRecord(withProgress, input)
      this.rows.set(projectionRunKey(input.projectId, input.id), structuredClone(next))
      return publicRecord(next)
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<ProjectionRunRecord | null> {
    return this.runRootOperation(() => {
      const record = this.rows.get(projectionRunKey(params.projectId, params.id))
      return record ? publicRecord(record) : null
    })
  }

  async list(input: ListProjectionRunsInput): Promise<ListProjectionRunsResult> {
    return this.runRootOperation(() => {
      assertNonEmpty(input.projectId, "projectId")
      assertOptionalWindowValue(input.limit, "limit")
      assertOptionalWindowValue(input.offset, "offset")
      if (input.statuses?.length === 0) return { runs: [], hasMore: false, total: 0 }

      const order = input.order ?? "desc"
      const offset = input.offset ?? 0
      const limit = input.limit ?? this.rows.size
      const statuses = input.statuses ? new Set(input.statuses) : null
      const objectTypeIds = input.objectTypeIds ? new Set(input.objectTypeIds) : null
      const filtered = [...this.rows.values()]
        .filter((record) => record.projectId === input.projectId)
        .filter((record) =>
          input.projectionId ? record.identity.projectionId === input.projectionId : true
        )
        .filter((record) =>
          input.projectionKind ? record.identity.projectionKind === input.projectionKind : true
        )
        .filter((record) =>
          input.datasetId ? record.identity.datasetVersion.datasetId === input.datasetId : true
        )
        .filter((record) =>
          input.datasetVersionId
            ? record.identity.datasetVersion.versionId === input.datasetVersionId
            : true
        )
        .filter((record) =>
          objectTypeIds
            ? projectionRunObjectTypesVisible(record, (id) => objectTypeIds.has(id))
            : true
        )
        .filter((record) => (statuses ? statuses.has(record.status) : true))
        .filter((record) => (input.startedAfter ? record.startedAt >= input.startedAfter : true))
        .filter((record) => (input.startedBefore ? record.startedAt <= input.startedBefore : true))
        .sort((left, right) => compareRuns(left, right, order))

      const total = filtered.length
      const runs = filtered.slice(offset, offset + limit).map(publicRecord)
      return { runs, hasMore: offset + runs.length < total, total }
    })
  }

  async listLatestByProjectionIds(
    input: ListLatestProjectionRunsInput
  ): Promise<ListLatestProjectionRunsResult> {
    return this.runRootOperation(() => {
      const runs = latestStartedAtByOwnerId(
        [...this.rows.values()].filter((record) => record.projectId === input.projectId),
        input.projectionIds,
        (record) => record.identity.projectionId
      )
      return { runs: runs.map(publicRecord) }
    })
  }

  private assertDatasetVersionIsImmutable(input: StartOrReclaimProjectionRunInput): void {
    for (const candidate of this.rows.values()) {
      if (
        candidate.projectId === input.projectId &&
        candidate.id !== input.id &&
        candidate.identity.datasetVersion.datasetId === input.identity.datasetVersion.datasetId &&
        candidate.identity.datasetVersion.versionId === input.identity.datasetVersion.versionId &&
        candidate.identity.datasetVersion.createdAt !== input.identity.datasetVersion.createdAt
      ) {
        throw new ProjectionRunError(
          `[Sixb] Dataset version '${input.identity.datasetVersion.versionId}' reused an immutable dataset version id with different metadata.`
        )
      }
    }
  }

  private issueExecutionToken(
    key: string,
    runId: string,
    currentToken: string | undefined
  ): string {
    const executionToken = this.createExecutionToken()
    assertNonEmpty(executionToken, "executionToken")
    const usedTokens = this.executionTokensByRun.get(key) ?? new Set<string>()
    if (currentToken) usedTokens.add(currentToken)
    if (usedTokens.has(executionToken)) {
      throw new ProjectionRunError(
        `[Sixb] Projection run '${runId}' execution token was already used.`
      )
    }
    usedTokens.add(executionToken)
    this.executionTokensByRun.set(key, usedTokens)
    return executionToken
  }

  private requireExecution(
    input: LockProjectionRunForMaterializationInput
  ): StoredProjectionRunRecord & { readonly executionToken: string } {
    assertNonEmpty(input.executionToken, "executionToken")
    assertIdentity(input.identity)
    const record = this.requireRunning(input.projectId, input.id)
    assertIdentityMatches(record, input.identity)
    if (record.executionToken !== input.executionToken) {
      throw new ProjectionRunError(
        `[Sixb] Projection run '${input.id}' execution token is stale.`,
        "execution-lost"
      )
    }
    return record as StoredProjectionRunRecord & { readonly executionToken: string }
  }

  private requireTelemetryExecution(
    input: LockProjectionRunForMaterializationInput
  ): TelemetryProjectionRunRecord & { readonly executionToken: string } {
    const record = this.requireExecution(input)
    if (record.identity.projectionKind !== "telemetry") {
      throw new ProjectionRunError(
        `[Sixb] Projection run '${record.id}' does not have a telemetry checkpoint.`
      )
    }
    return record as TelemetryProjectionRunRecord & { readonly executionToken: string }
  }

  private requireRunning(projectId: string, id: string): StoredProjectionRunRecord {
    assertNonEmpty(projectId, "projectId")
    assertNonEmpty(id, "id")
    const record = this.rows.get(projectionRunKey(projectId, id))
    if (!record) {
      throw new ProjectionRunError(
        `[Sixb] Projection run '${id}' not found for project '${projectId}'.`
      )
    }
    this.assertRunning(record)
    return record
  }

  private assertRunning(record: ProjectionRunRecord): void {
    if (record.status !== "running") {
      throw new ProjectionRunError(
        `[Sixb] Projection run '${record.id}' for project '${record.projectId}' is already terminal.`
      )
    }
  }
}

export interface InMemoryProjectionRunStorageSnapshot {
  readonly rows: Map<string, StoredProjectionRunRecord>
  readonly executionTokensByRun: Map<string, Set<string>>
}
