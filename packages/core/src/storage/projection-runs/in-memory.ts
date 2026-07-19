import { randomUUID } from "node:crypto"
import { stableJsonStringify } from "../../json"
import type { AssertSourceMaterializationExecutionInput } from "../ontology/sources"
import { latestStartedAtByOwnerId } from "../run-listing"
import { ProjectionRunError } from "./errors"
import {
  type AssertProjectionMaterializationExecutionInput,
  type FinishProjectionMaterializationInput,
  type FinishProjectionRunInput,
  type ListLatestProjectionRunsInput,
  type ListLatestProjectionRunsResult,
  type ListProjectionRunsInput,
  type ListProjectionRunsResult,
  PROJECTION_COUNTER_KEYS,
  type ProjectionMaterializationRunRecord,
  type ProjectionMaterializationRunStorage,
  type ProjectionRunCounters,
  type ProjectionRunMaterializationBookkeeping,
  type ProjectionRunMaterializationIdentity,
  type ProjectionRunMaterializationReplay,
  type ProjectionRunObjectTypes,
  type ProjectionRunRecord,
  projectionRunObjectTypesVisible,
  type StartOrReclaimProjectionMaterializationInput,
  type StartProjectionRunInput,
  type UpdateProjectionMaterializationInput,
  type UpdateProjectionRunInput,
  zeroProjectionRunCounters,
  zeroProjectionRunMaterializationCounters,
} from "./types"

type RunRootOperation = <T>(run: () => Promise<T> | T) => Promise<T>

const runDirectly: RunRootOperation = async <T>(run: () => Promise<T> | T): Promise<T> => run()

function projectionRunKey(projectId: string, id: string): string {
  return JSON.stringify([projectId, id])
}

function telemetryCommitKey(projectId: string, runId: string, batchOrdinal: number): string {
  return JSON.stringify([projectId, runId, batchOrdinal])
}

type StoredProjectionRunRecord = ProjectionRunRecord & { readonly executionToken?: string }

type StoredTelemetryMaterializationCommit = Omit<
  Extract<ProjectionRunMaterializationBookkeeping, { readonly protocol: "telemetry" }>,
  "execution"
> & { readonly execution: { readonly projectionRunId: string } }

function cloneProjectionRunRecord<T extends StoredProjectionRunRecord>(record: T): T {
  return structuredClone(record)
}

function publicProjectionRunRecord(record: StoredProjectionRunRecord): ProjectionRunRecord {
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

function assertOptionalCounter(value: number | undefined, fieldName: string): void {
  if (value !== undefined) assertCounter(value, fieldName)
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

function compareRuns(a: ProjectionRunRecord, b: ProjectionRunRecord, order: "asc" | "desc") {
  const delta = a.startedAt.getTime() - b.startedAt.getTime()
  if (delta !== 0) return order === "asc" ? delta : -delta
  if (a.id === b.id) return 0
  return order === "asc" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)
}

function applyCounters<TRecord extends ProjectionRunRecord>(
  record: TRecord,
  input: Partial<ProjectionRunCounters>
): TRecord {
  const merged = {} as Record<keyof ProjectionRunCounters, number>
  for (const key of PROJECTION_COUNTER_KEYS) {
    assertOptionalCounter(input[key], key)
    merged[key] = input[key] ?? record[key]
  }
  return { ...record, ...merged }
}

function assertLegacyMutationAllowed(
  record: ProjectionRunRecord,
  operation: "update" | "finish"
): void {
  if (record.materializationProtocol !== undefined) {
    throw new ProjectionRunError(
      `[Sixb] Projection materialization run '${record.id}' cannot use legacy ${operation}(); use ${operation}Materialization() with the current execution token.`
    )
  }
}

function assertIdentity(identity: ProjectionRunMaterializationIdentity): void {
  assertNonEmpty(identity.projectionId, "projectionId")
  if (
    identity.projectionKind !== "object" &&
    identity.projectionKind !== "link" &&
    identity.projectionKind !== "telemetry"
  ) {
    throw new ProjectionRunError(
      "[Sixb] Projection run projectionKind must be 'object', 'link', or 'telemetry'."
    )
  }
  if (identity.protocol !== "replacement" && identity.protocol !== "telemetry") {
    throw new ProjectionRunError(
      "[Sixb] Projection run protocol must be 'replacement' or 'telemetry'."
    )
  }
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

function assertObjectTypes(
  kind: ProjectionRunRecord["projectionKind"],
  input: ProjectionRunObjectTypes
) {
  if (kind === "link") {
    assertNonEmpty(input.sourceObjectTypeId ?? "", "sourceObjectTypeId")
    assertNonEmpty(input.targetObjectTypeId ?? "", "targetObjectTypeId")
    if (input.objectTypeId !== undefined) {
      throw new ProjectionRunError(
        "[Sixb] Link projection runs cannot declare a singular objectTypeId."
      )
    }
    return
  }
  assertNonEmpty(input.objectTypeId ?? "", "objectTypeId")
  if (input.sourceObjectTypeId !== undefined || input.targetObjectTypeId !== undefined) {
    throw new ProjectionRunError(
      "[Sixb] Object and telemetry projection runs cannot declare link endpoint types."
    )
  }
}

function assertMaterializationIdentityMatches(
  record: ProjectionRunRecord,
  identity: ProjectionRunMaterializationIdentity
): void {
  if (
    record.projectionId !== identity.projectionId ||
    record.projectionKind !== identity.projectionKind ||
    record.materializationProtocol !== identity.protocol ||
    record.datasetId !== identity.datasetVersion.datasetId ||
    record.datasetVersionId !== identity.datasetVersion.versionId ||
    record.datasetVersionCreatedAt !== identity.datasetVersion.createdAt ||
    record.ontologyRevision !== identity.ontologyRevision ||
    record.projectionRevision !== identity.projectionRevision ||
    record.ownershipHash !== identity.ownershipHash
  ) {
    throw new ProjectionRunError(
      `[Sixb] Projection run '${record.id}' materialization identity does not match.`
    )
  }
}

function assertObjectTypesMatch(
  record: ProjectionRunRecord,
  input: ProjectionRunObjectTypes
): void {
  if (
    record.objectTypeId !== input.objectTypeId ||
    record.sourceObjectTypeId !== input.sourceObjectTypeId ||
    record.targetObjectTypeId !== input.targetObjectTypeId
  ) {
    throw new ProjectionRunError(
      `[Sixb] Projection run '${record.id}' target object types do not match.`
    )
  }
}

function assertCompleteMaterializationRecord(
  record: StoredProjectionRunRecord
): asserts record is ProjectionMaterializationRunRecord {
  if (
    record.attempt === undefined ||
    !record.executionToken ||
    !record.materializationProtocol ||
    !record.datasetVersionCreatedAt ||
    !record.ontologyRevision ||
    !record.projectionRevision ||
    !record.ownershipHash ||
    record.materializationCommitCount === undefined ||
    record.materializationCounters === undefined
  ) {
    throw new ProjectionRunError(
      `[Sixb] Projection run '${record.id}' has incomplete materialization state.`
    )
  }
}

function identityFromBookkeeping(
  bookkeeping: ProjectionRunMaterializationBookkeeping | ProjectionRunMaterializationReplay
): ProjectionRunMaterializationIdentity {
  return {
    projectionId: bookkeeping.projectionId,
    projectionKind: bookkeeping.projectionKind,
    protocol: bookkeeping.protocol,
    datasetVersion: bookkeeping.datasetVersion,
    ontologyRevision: bookkeeping.ontologyRevision,
    projectionRevision: bookkeeping.projectionRevision,
    ownershipHash: bookkeeping.ownershipHash,
  }
}

function telemetryBookkeepingFingerprint(
  bookkeeping:
    | Extract<ProjectionRunMaterializationBookkeeping, { readonly protocol: "telemetry" }>
    | StoredTelemetryMaterializationCommit
): string {
  return stableJsonStringify({
    ...bookkeeping,
    execution: { projectionRunId: bookkeeping.execution.projectionRunId },
  })
}

export class InMemoryProjectionRunStorage implements ProjectionMaterializationRunStorage {
  private readonly rows = new Map<string, StoredProjectionRunRecord>()
  private readonly telemetryCommits = new Map<string, StoredTelemetryMaterializationCommit>()
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
      telemetryCommits: this.telemetryCommits,
      executionTokensByRun: this.executionTokensByRun,
    })
  }

  restore(snapshot: InMemoryProjectionRunStorageSnapshot): void {
    this.rows.clear()
    this.telemetryCommits.clear()
    this.executionTokensByRun.clear()
    for (const [key, record] of structuredClone(snapshot.rows)) this.rows.set(key, record)
    for (const [key, record] of structuredClone(snapshot.telemetryCommits)) {
      this.telemetryCommits.set(key, record)
    }
    for (const [key, tokens] of structuredClone(snapshot.executionTokensByRun)) {
      this.executionTokensByRun.set(key, tokens)
    }
  }

  async startOrReclaimMaterialization(
    input: StartOrReclaimProjectionMaterializationInput
  ): Promise<ProjectionMaterializationRunRecord> {
    return this.runRootOperation(() => {
      assertNonEmpty(input.id, "id")
      assertNonEmpty(input.projectId, "projectId")
      assertIdentity(input.identity)
      assertObjectTypes(input.identity.projectionKind, input)
      if (input.identity.protocol === "telemetry") {
        assertPositiveCounter(input.fixedBatchSize ?? 0, "fixedBatchSize")
      } else if (input.fixedBatchSize !== undefined) {
        throw new ProjectionRunError(
          "[Sixb] Replacement projection runs cannot declare a telemetry fixedBatchSize."
        )
      }

      const key = projectionRunKey(input.projectId, input.id)
      const existing = this.rows.get(key)
      if (existing) {
        this.assertRunning(existing)
        assertMaterializationIdentityMatches(existing, input.identity)
        assertObjectTypesMatch(existing, input)
        if (existing.fixedBatchSize !== input.fixedBatchSize) {
          throw new ProjectionRunError(
            `[Sixb] Projection run '${input.id}' fixed batch size does not match.`
          )
        }
        assertCompleteMaterializationRecord(existing)
      }

      const previousAttempt = existing?.attempt ?? 0
      if (!Number.isSafeInteger(previousAttempt + 1)) {
        throw new ProjectionRunError(
          `[Sixb] Projection run '${input.id}' attempt exceeds safe integer range.`
        )
      }
      const executionToken = this.createExecutionToken()
      assertNonEmpty(executionToken, "executionToken")
      const usedExecutionTokens =
        this.executionTokensByRun.get(key) ??
        new Set(existing?.executionToken ? [existing.executionToken] : [])
      if (usedExecutionTokens.has(executionToken)) {
        throw new ProjectionRunError(
          `[Sixb] Projection run '${input.id}' execution token was already used.`
        )
      }

      const record: ProjectionMaterializationRunRecord = existing
        ? {
            ...existing,
            attempt: previousAttempt + 1,
            executionToken,
          }
        : {
            id: input.id,
            projectId: input.projectId,
            projectionId: input.identity.projectionId,
            projectionKind: input.identity.projectionKind,
            datasetId: input.identity.datasetVersion.datasetId,
            datasetVersionId: input.identity.datasetVersion.versionId,
            objectTypeId: input.objectTypeId,
            sourceObjectTypeId: input.sourceObjectTypeId,
            targetObjectTypeId: input.targetObjectTypeId,
            status: "running",
            startedAt: new Date(input.startedAt ?? new Date()),
            attempt: 1,
            executionToken,
            materializationProtocol: input.identity.protocol,
            datasetVersionCreatedAt: input.identity.datasetVersion.createdAt,
            ontologyRevision: input.identity.ontologyRevision,
            projectionRevision: input.identity.projectionRevision,
            ownershipHash: input.identity.ownershipHash,
            ...(input.fixedBatchSize !== undefined ? { fixedBatchSize: input.fixedBatchSize } : {}),
            materializationCommitCount: 0,
            materializationCounters: zeroProjectionRunMaterializationCounters(),
            ...zeroProjectionRunCounters(),
          }

      this.rows.set(key, structuredClone(record))
      usedExecutionTokens.add(executionToken)
      this.executionTokensByRun.set(key, usedExecutionTokens)
      return cloneProjectionRunRecord(record)
    })
  }

  async assertMaterializationExecution(
    input: AssertProjectionMaterializationExecutionInput
  ): Promise<ProjectionMaterializationRunRecord> {
    return this.runRootOperation(() =>
      cloneProjectionRunRecord(this.requireMaterializationExecution(input))
    )
  }

  /**
   * @internal The caller must already hold InMemoryStorage's root operation lock.
   * Source staging deliberately has only the run id, projection id and token;
   * the source manifest carries the remaining immutable identity.
   */
  assertSourceMaterializationExecutionUnlocked(
    input: AssertSourceMaterializationExecutionInput
  ): void {
    assertNonEmpty(input.source.projectionId, "projectionId")
    assertNonEmpty(input.execution.executionToken, "executionToken")
    const record = this.requireRunning(input.projectId, input.execution.projectionRunId)
    if (
      record.projectionId !== input.source.projectionId ||
      record.materializationProtocol !== "replacement"
    ) {
      throw new ProjectionRunError(
        `[Sixb] Projection run '${record.id}' does not own replacement source '${input.source.projectionId}'.`
      )
    }
    if (!record.executionToken || record.executionToken !== input.execution.executionToken) {
      throw new ProjectionRunError(
        `[Sixb] Projection run '${record.id}' execution token is stale.`,
        "execution-lost"
      )
    }
  }

  async updateMaterialization(
    input: UpdateProjectionMaterializationInput
  ): Promise<ProjectionMaterializationRunRecord> {
    return this.runRootOperation(() => {
      const existing = this.requireMaterializationExecution(input)
      const next = applyCounters(existing, input)
      this.rows.set(projectionRunKey(input.projectId, input.id), structuredClone(next))
      return cloneProjectionRunRecord(next)
    })
  }

  async finishMaterialization(
    input: FinishProjectionMaterializationInput
  ): Promise<ProjectionRunRecord> {
    return this.runRootOperation(() => {
      const existing = this.requireMaterializationExecution(input)
      if (existing.materializationProtocol === "replacement") {
        if (input.status === "succeeded" && !existing.replacementCommitId) {
          throw new ProjectionRunError(
            `[Sixb] Projection replacement run '${existing.id}' cannot succeed before its materialization commit is linked.`
          )
        }
        if (input.status !== "succeeded" && existing.replacementCommitId) {
          throw new ProjectionRunError(
            `[Sixb] Projection replacement run '${existing.id}' cannot finish as '${input.status}' after its materialization commit is linked.`
          )
        }
      }
      const withCounters = applyCounters(existing, input)
      const next: StoredProjectionRunRecord = {
        ...withCounters,
        executionToken: undefined,
        status: input.status,
        finishedAt: new Date(input.finishedAt ?? new Date()),
        errorMessage: input.status === "succeeded" ? undefined : input.errorMessage,
      }
      this.rows.set(projectionRunKey(input.projectId, input.id), structuredClone(next))
      return publicProjectionRunRecord(next)
    })
  }

  async recordMaterializationCommit(
    projectId: string,
    bookkeeping: ProjectionRunMaterializationBookkeeping
  ): Promise<void> {
    await this.runRootOperation(() => this.recordMaterialization(bookkeeping, projectId))
  }

  async recordMaterializationReplay(
    projectId: string,
    replay: ProjectionRunMaterializationReplay
  ): Promise<void> {
    await this.runRootOperation(() => this.assertMaterializationReplay(replay, projectId))
  }

  async start(input: StartProjectionRunInput): Promise<ProjectionRunRecord> {
    return this.runRootOperation(() => {
      assertNonEmpty(input.id, "id")
      assertNonEmpty(input.projectId, "projectId")
      assertNonEmpty(input.projectionId, "projectionId")
      assertNonEmpty(input.datasetId, "datasetId")
      assertNonEmpty(input.datasetVersionId, "datasetVersionId")

      const key = projectionRunKey(input.projectId, input.id)
      if (this.rows.has(key)) {
        throw new ProjectionRunError(
          `[Sixb] Projection run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }
      const record: ProjectionRunRecord = {
        id: input.id,
        projectId: input.projectId,
        projectionId: input.projectionId,
        projectionKind: input.projectionKind,
        datasetId: input.datasetId,
        datasetVersionId: input.datasetVersionId,
        objectTypeId: input.objectTypeId,
        sourceObjectTypeId: input.sourceObjectTypeId,
        targetObjectTypeId: input.targetObjectTypeId,
        status: "running",
        startedAt: new Date(input.startedAt ?? new Date()),
        attempt: 0,
        materializationCommitCount: 0,
        materializationCounters: zeroProjectionRunMaterializationCounters(),
        ...zeroProjectionRunCounters(),
      }
      this.rows.set(key, structuredClone(record))
      return publicProjectionRunRecord(record)
    })
  }

  async update(input: UpdateProjectionRunInput): Promise<ProjectionRunRecord> {
    return this.runRootOperation(() => {
      const existing = this.requireRunning(input.projectId, input.id)
      assertLegacyMutationAllowed(existing, "update")
      const next = applyCounters(existing, input)
      this.rows.set(projectionRunKey(input.projectId, input.id), structuredClone(next))
      return publicProjectionRunRecord(next)
    })
  }

  async finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord> {
    return this.runRootOperation(() => {
      const existing = this.requireRunning(input.projectId, input.id)
      assertLegacyMutationAllowed(existing, "finish")
      const withCounters = applyCounters(existing, input)
      const next: StoredProjectionRunRecord = {
        ...withCounters,
        executionToken: undefined,
        status: input.status,
        finishedAt: new Date(input.finishedAt ?? new Date()),
        errorMessage: input.status === "succeeded" ? undefined : input.errorMessage,
      }
      this.rows.set(projectionRunKey(input.projectId, input.id), structuredClone(next))
      return publicProjectionRunRecord(next)
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<ProjectionRunRecord | null> {
    return this.runRootOperation(() => {
      const record = this.rows.get(projectionRunKey(params.projectId, params.id))
      return record ? publicProjectionRunRecord(record) : null
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
          input.projectionId ? record.projectionId === input.projectionId : true
        )
        .filter((record) =>
          input.projectionKind ? record.projectionKind === input.projectionKind : true
        )
        .filter((record) => (input.datasetId ? record.datasetId === input.datasetId : true))
        .filter((record) =>
          input.datasetVersionId ? record.datasetVersionId === input.datasetVersionId : true
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
      const runs = filtered.slice(offset, offset + limit).map(publicProjectionRunRecord)
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
        (record) => record.projectionId
      )
      return { runs: runs.map(publicProjectionRunRecord) }
    })
  }

  private recordMaterialization(
    bookkeeping: ProjectionRunMaterializationBookkeeping,
    projectId: string
  ): void {
    assertNonEmpty(projectId, "projectId")
    assertNonEmpty(bookkeeping.commitId, "materialization commitId")
    const runId = bookkeeping.execution.projectionRunId
    const identity = identityFromBookkeeping(bookkeeping)
    assertIdentity(identity)
    const existing = this.requireMaterializationExecution({
      id: runId,
      projectId,
      executionToken: bookkeeping.execution.executionToken,
      identity,
    })

    if (bookkeeping.protocol === "replacement") {
      assertCounter(bookkeeping.stagedRootCount, "stagedRootCount")
      assertCounter(bookkeeping.stagedAssertionCount, "stagedAssertionCount")
      for (const [name, value] of Object.entries(bookkeeping.counts)) assertCounter(value, name)

      if (existing.replacementCommitId) {
        if (
          existing.replacementCommitId === bookkeeping.commitId &&
          existing.materializationCounters.stagedRootCount === bookkeeping.stagedRootCount &&
          existing.materializationCounters.stagedAssertionCount ===
            bookkeeping.stagedAssertionCount &&
          stableJsonStringify({
            objectsCreated: existing.materializationCounters.objectsCreated,
            objectsUpdated: existing.materializationCounters.objectsUpdated,
            objectsDeleted: existing.materializationCounters.objectsDeleted,
            objectsUnchanged: existing.materializationCounters.objectsUnchanged,
            linksCreated: existing.materializationCounters.linksCreated,
            linksUpdated: existing.materializationCounters.linksUpdated,
            linksDeleted: existing.materializationCounters.linksDeleted,
            linksUnchanged: existing.materializationCounters.linksUnchanged,
          }) === stableJsonStringify(bookkeeping.counts)
        ) {
          return
        }
        throw new ProjectionRunError(
          `[Sixb] Replacement projection run '${runId}' already links a different materialization commit.`
        )
      }

      const next: ProjectionMaterializationRunRecord = {
        ...existing,
        replacementCommitId: bookkeeping.commitId,
        lastMaterializationCommitId: bookkeeping.commitId,
        materializationCommitCount: 1,
        materializationCounters: {
          ...existing.materializationCounters,
          stagedRootCount: bookkeeping.stagedRootCount,
          stagedAssertionCount: bookkeeping.stagedAssertionCount,
          ...bookkeeping.counts,
        },
      }
      this.rows.set(projectionRunKey(projectId, runId), structuredClone(next))
      return
    }

    const fixedBatchSize = existing.fixedBatchSize
    if (fixedBatchSize === undefined) {
      throw new ProjectionRunError(
        `[Sixb] Telemetry projection run '${runId}' has no fixed batch size.`
      )
    }
    assertCounter(bookkeeping.batchOrdinal, "batchOrdinal")
    assertPositiveCounter(bookkeeping.batchInputCount, "batchInputCount")
    assertCounter(bookkeeping.batchPointCount, "batchPointCount")
    const telemetryCounts = {
      pointsCreated: bookkeeping.pointsCreated,
      pointsUpdated: bookkeeping.pointsUpdated,
      pointsUnchanged: bookkeeping.pointsUnchanged,
      latestObjectsChanged: bookkeeping.latestObjectsChanged,
    }
    for (const [name, value] of Object.entries(telemetryCounts)) assertCounter(value, name)
    if (
      bookkeeping.pointsCreated + bookkeeping.pointsUpdated + bookkeeping.pointsUnchanged !==
      bookkeeping.batchPointCount
    ) {
      throw new ProjectionRunError(
        `[Sixb] Telemetry projection run '${runId}' batch counters do not match its point count.`
      )
    }
    if (bookkeeping.batchPointCount > bookkeeping.batchInputCount) {
      throw new ProjectionRunError(
        `[Sixb] Telemetry projection run '${runId}' normalized point count exceeds its input count.`
      )
    }
    if (bookkeeping.batchInputCount > fixedBatchSize) {
      throw new ProjectionRunError(
        `[Sixb] Telemetry projection run '${runId}' batch exceeds its fixed size.`
      )
    }

    const commitKey = telemetryCommitKey(projectId, runId, bookkeeping.batchOrdinal)
    const committed = this.telemetryCommits.get(commitKey)
    if (committed) {
      if (
        telemetryBookkeepingFingerprint(committed) === telemetryBookkeepingFingerprint(bookkeeping)
      ) {
        return
      }
      throw new ProjectionRunError(
        `[Sixb] Telemetry projection run '${runId}' batch ordinal ${bookkeeping.batchOrdinal} already links a different commit.`
      )
    }

    const expectedOrdinal = (existing.lastCommittedBatchOrdinal ?? -1) + 1
    if (bookkeeping.batchOrdinal !== expectedOrdinal) {
      throw new ProjectionRunError(
        `[Sixb] Telemetry projection run '${runId}' expected batch ordinal ${expectedOrdinal}, got ${bookkeeping.batchOrdinal}.`
      )
    }
    if (bookkeeping.batchOrdinal > 0) {
      const previous = this.telemetryCommits.get(
        telemetryCommitKey(projectId, runId, bookkeeping.batchOrdinal - 1)
      )
      if (!previous || previous.batchInputCount !== fixedBatchSize) {
        throw new ProjectionRunError(
          `[Sixb] Telemetry projection run '${runId}' cannot continue after a partial batch.`
        )
      }
    }

    const counters = existing.materializationCounters
    const next: ProjectionMaterializationRunRecord = {
      ...existing,
      lastCommittedBatchOrdinal: bookkeeping.batchOrdinal,
      lastMaterializationCommitId: bookkeeping.commitId,
      materializationCommitCount: safeAdd(
        existing.materializationCommitCount,
        1,
        "materializationCommitCount"
      ),
      materializationCounters: {
        ...counters,
        telemetryPointsCreated: safeAdd(
          counters.telemetryPointsCreated,
          bookkeeping.pointsCreated,
          "telemetryPointsCreated"
        ),
        telemetryPointsUpdated: safeAdd(
          counters.telemetryPointsUpdated,
          bookkeeping.pointsUpdated,
          "telemetryPointsUpdated"
        ),
        telemetryPointsUnchanged: safeAdd(
          counters.telemetryPointsUnchanged,
          bookkeeping.pointsUnchanged,
          "telemetryPointsUnchanged"
        ),
        latestObjectsChanged: safeAdd(
          counters.latestObjectsChanged,
          bookkeeping.latestObjectsChanged,
          "latestObjectsChanged"
        ),
      },
    }
    this.telemetryCommits.set(commitKey, {
      ...structuredClone(bookkeeping),
      execution: { projectionRunId: bookkeeping.execution.projectionRunId },
    })
    this.rows.set(projectionRunKey(projectId, runId), structuredClone(next))
  }

  private assertMaterializationReplay(
    replay: ProjectionRunMaterializationReplay,
    projectId: string
  ): void {
    assertNonEmpty(projectId, "projectId")
    assertNonEmpty(replay.commitId, "materialization commitId")
    if (replay.protocol === "telemetry") {
      assertCounter(replay.batchOrdinal, "batchOrdinal")
    }
    const runId = replay.execution.projectionRunId
    const existing = this.requireMaterializationExecution({
      id: runId,
      projectId,
      executionToken: replay.execution.executionToken,
      identity: identityFromBookkeeping(replay),
    })

    if (replay.protocol === "replacement") {
      if (existing.replacementCommitId !== replay.commitId) {
        throw new ProjectionRunError(
          `[Sixb] Replacement projection run '${runId}' is not linked to materialization commit '${replay.commitId}'.`
        )
      }
      return
    }

    const committed = this.telemetryCommits.get(
      telemetryCommitKey(projectId, runId, replay.batchOrdinal)
    )
    if (!committed || committed.commitId !== replay.commitId) {
      throw new ProjectionRunError(
        `[Sixb] Telemetry projection run '${runId}' batch ordinal ${replay.batchOrdinal} is not linked to materialization commit '${replay.commitId}'.`
      )
    }
  }

  private requireMaterializationExecution(
    input: AssertProjectionMaterializationExecutionInput
  ): ProjectionMaterializationRunRecord {
    assertNonEmpty(input.executionToken, "executionToken")
    assertIdentity(input.identity)
    const record = this.requireRunning(input.projectId, input.id)
    assertMaterializationIdentityMatches(record, input.identity)
    if (!record.executionToken || record.executionToken !== input.executionToken) {
      throw new ProjectionRunError(
        `[Sixb] Projection run '${input.id}' execution token is stale.`,
        "execution-lost"
      )
    }
    assertCompleteMaterializationRecord(record)
    return record
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
  readonly telemetryCommits: Map<string, StoredTelemetryMaterializationCommit>
  readonly executionTokensByRun: Map<string, Set<string>>
}
