import { randomUUID } from "node:crypto"
import type { AssertSourceMaterializationExecutionInput } from "../ontology/sources"
import { latestStartedAtByOwnerId } from "../run-listing"
import { ProjectionRunError } from "./errors"
import {
  advanceProjectionTelemetry,
  assertGenericProgressDoesNotAdvanceTelemetry,
  assertProjectionMissingTarget,
  assertProjectionRunExecution,
  assertProjectionRunIdentityMatches,
  assertProjectionRunListWindow,
  assertProjectionRunNonEmpty,
  assertProjectionRunRunning,
  assertProjectionRunStartInput,
  createProjectionRunClaim,
  createProjectionRunRecord,
  finishProjectionRunRecord,
  immutableDatasetVersionConflict,
  mergeProjectionRunProgress,
  planProjectionRunReclaim,
  projectionRunNotFound,
  publicProjectionRunRecord,
  requireTelemetryProjectionRun,
  type StoredProjectionRunRecord,
  staleProjectionRunExecution,
} from "./lifecycle"
import {
  type AdvanceProjectionTelemetryCheckpointInput,
  type FinishProjectionRunInput,
  type ListLatestProjectionRunsInput,
  type ListLatestProjectionRunsResult,
  type ListProjectionRunsInput,
  type ListProjectionRunsResult,
  type LockProjectionRunForMaterializationInput,
  type ProjectionRunClaim,
  type ProjectionRunRecord,
  type ProjectionRunStorage,
  projectionRunObjectTypesVisible,
  type RecordProjectionMissingTargetInput,
  type StartOrReclaimProjectionRunInput,
  type TelemetryProjectionRunRecord,
  type UpdateProjectionRunInput,
} from "./types"

type RunRootOperation = <T>(run: () => Promise<T> | T) => Promise<T>
const runDirectly: RunRootOperation = async <T>(run: () => Promise<T> | T): Promise<T> => run()

function projectionRunKey(projectId: string, id: string): string {
  return JSON.stringify([projectId, id])
}

function compareRuns(a: ProjectionRunRecord, b: ProjectionRunRecord, order: "asc" | "desc") {
  const delta = a.startedAt.getTime() - b.startedAt.getTime()
  if (delta !== 0) return order === "asc" ? delta : -delta
  if (a.id === b.id) return 0
  return order === "asc" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)
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
      assertProjectionRunStartInput(input)
      this.assertDatasetVersionIsImmutable(input)

      const key = projectionRunKey(input.projectId, input.id)
      const existing = this.rows.get(key)
      const attempt = existing ? planProjectionRunReclaim(existing, input).attempt : 1
      const executionToken = this.issueExecutionToken(key, input.id, existing?.executionToken)
      const record: StoredProjectionRunRecord = existing
        ? { ...existing, attempt, executionToken }
        : { ...createProjectionRunRecord(input), executionToken }

      this.rows.set(key, structuredClone(record))
      return createProjectionRunClaim(record)
    })
  }

  async lockForMaterialization(
    input: LockProjectionRunForMaterializationInput
  ): Promise<ProjectionRunRecord> {
    return this.runRootOperation(() => publicProjectionRunRecord(this.requireExecution(input)))
  }

  /** @internal The caller must already hold InMemoryStorage's root operation lock. */
  assertSourceMaterializationExecutionUnlocked(
    input: AssertSourceMaterializationExecutionInput
  ): void {
    assertProjectionRunNonEmpty(input.source.projectionId, "projectionId")
    assertProjectionRunNonEmpty(input.execution.executionToken, "executionToken")
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
      throw staleProjectionRunExecution(record.id)
    }
    if (input.identity) {
      assertProjectionRunIdentityMatches(record, {
        projectionId: input.source.projectionId,
        ...input.identity,
      })
    }
  }

  async update(input: UpdateProjectionRunInput): Promise<ProjectionRunRecord> {
    return this.runRootOperation(() => {
      const existing = this.requireExecution(input)
      assertGenericProgressDoesNotAdvanceTelemetry(existing, input.progress)
      const next = {
        ...existing,
        progress: mergeProjectionRunProgress(existing.progress, input.progress),
      }
      this.rows.set(projectionRunKey(input.projectId, input.id), structuredClone(next))
      return publicProjectionRunRecord(next)
    })
  }
  async advanceTelemetryCheckpoint(
    input: AdvanceProjectionTelemetryCheckpointInput
  ): Promise<TelemetryProjectionRunRecord> {
    return this.runRootOperation(() => {
      const existing = this.requireTelemetryExecution(input)
      const advance = advanceProjectionTelemetry(existing, input)
      const next: TelemetryProjectionRunRecord & { readonly executionToken: string } = {
        ...existing,
        progress: advance.progress,
        telemetryCheckpoint: advance.checkpoint,
        missingTarget: undefined,
      }
      this.rows.set(projectionRunKey(input.projectId, input.id), structuredClone(next))
      return publicProjectionRunRecord(next) as TelemetryProjectionRunRecord
    })
  }

  async recordMissingTarget(
    input: RecordProjectionMissingTargetInput
  ): Promise<TelemetryProjectionRunRecord> {
    return this.runRootOperation(() => {
      const existing = this.requireTelemetryExecution(input)
      const next: TelemetryProjectionRunRecord & { readonly executionToken: string } = {
        ...existing,
        missingTarget: assertProjectionMissingTarget(existing, input.missingTarget),
      }
      this.rows.set(projectionRunKey(input.projectId, input.id), structuredClone(next))
      return publicProjectionRunRecord(next) as TelemetryProjectionRunRecord
    })
  }

  async finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord> {
    return this.runRootOperation(() => {
      const existing = this.requireExecution(input)
      const next = finishProjectionRunRecord(existing, input)
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
      assertProjectionRunNonEmpty(input.projectId, "projectId")
      assertProjectionRunListWindow(input.limit, "limit")
      assertProjectionRunListWindow(input.offset, "offset")
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
        (record) => record.identity.projectionId
      )
      return { runs: runs.map(publicProjectionRunRecord) }
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
        throw immutableDatasetVersionConflict(input.identity)
      }
    }
  }

  private issueExecutionToken(
    key: string,
    runId: string,
    currentToken: string | undefined
  ): string {
    const executionToken = this.createExecutionToken()
    assertProjectionRunNonEmpty(executionToken, "executionToken")
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
    const record = this.requireRunning(input.projectId, input.id)
    assertProjectionRunExecution(record, input)
    return record
  }

  private requireTelemetryExecution(
    input: LockProjectionRunForMaterializationInput
  ): TelemetryProjectionRunRecord & { readonly executionToken: string } {
    const record = this.requireExecution(input)
    return requireTelemetryProjectionRun(record)
  }

  private requireRunning(projectId: string, id: string): StoredProjectionRunRecord {
    assertProjectionRunNonEmpty(projectId, "projectId")
    assertProjectionRunNonEmpty(id, "id")
    const record = this.rows.get(projectionRunKey(projectId, id))
    if (!record) {
      throw projectionRunNotFound(projectId, id)
    }
    assertProjectionRunRunning(record)
    return record
  }
}

export interface InMemoryProjectionRunStorageSnapshot {
  readonly rows: Map<string, StoredProjectionRunRecord>
  readonly executionTokensByRun: Map<string, Set<string>>
}
