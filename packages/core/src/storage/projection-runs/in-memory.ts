import { latestStartedAtByOwnerId } from "../run-listing"
import { ProjectionRunError } from "./errors"
import {
  type FinishProjectionRunInput,
  type ListLatestProjectionRunsInput,
  type ListLatestProjectionRunsResult,
  type ListProjectionRunsInput,
  type ListProjectionRunsResult,
  PROJECTION_COUNTER_KEYS,
  type ProjectionRunCounters,
  type ProjectionRunRecord,
  type ProjectionRunStorage,
  projectionRunObjectTypesVisible,
  type StartProjectionRunInput,
  type UpdateProjectionRunInput,
  zeroProjectionRunCounters,
} from "./types"

function projectionRunKey(projectId: string, id: string): string {
  return `${projectId}:${id}`
}

function cloneProjectionRunRecord(record: ProjectionRunRecord): ProjectionRunRecord {
  return structuredClone(record)
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new ProjectionRunError(`[Sixb] Projection run ${fieldName} must not be empty.`)
  }
}

function assertCounter(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ProjectionRunError(
      `[Sixb] Projection run ${fieldName} must be a non-negative integer.`
    )
  }
}

function assertOptionalCounter(value: number | undefined, fieldName: string): void {
  if (value !== undefined) {
    assertCounter(value, fieldName)
  }
}

function assertOptionalWindowValue(value: number | undefined, fieldName: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new ProjectionRunError(`[Sixb] Projection run list ${fieldName} must be >= 0.`)
  }
}

function compareRuns(a: ProjectionRunRecord, b: ProjectionRunRecord, order: "asc" | "desc") {
  const delta = a.startedAt.getTime() - b.startedAt.getTime()
  if (delta !== 0) {
    return order === "asc" ? delta : -delta
  }

  if (a.id === b.id) {
    return 0
  }

  return order === "asc" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)
}

function applyCounters(
  record: ProjectionRunRecord,
  input: Partial<ProjectionRunCounters>
): ProjectionRunRecord {
  const merged = {} as Record<keyof ProjectionRunCounters, number>
  for (const key of PROJECTION_COUNTER_KEYS) {
    assertOptionalCounter(input[key], key)
    merged[key] = input[key] ?? record[key]
  }

  return { ...record, ...merged }
}

export class InMemoryProjectionRunStorage implements ProjectionRunStorage {
  private readonly rows = new Map<string, ProjectionRunRecord>()

  snapshot(): InMemoryProjectionRunStorageSnapshot {
    return structuredClone(this.rows)
  }

  restore(snapshot: InMemoryProjectionRunStorageSnapshot): void {
    this.rows.clear()
    for (const [key, record] of structuredClone(snapshot)) {
      this.rows.set(key, record)
    }
  }

  async start(input: StartProjectionRunInput): Promise<ProjectionRunRecord> {
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
      ...zeroProjectionRunCounters(),
    }

    this.rows.set(key, structuredClone(record))
    return cloneProjectionRunRecord(record)
  }

  async update(input: UpdateProjectionRunInput): Promise<ProjectionRunRecord> {
    const existing = this.requireRunning(input.projectId, input.id)
    const next = applyCounters(existing, input)

    this.rows.set(projectionRunKey(input.projectId, input.id), structuredClone(next))
    return cloneProjectionRunRecord(next)
  }

  async finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord> {
    const existing = this.requireRunning(input.projectId, input.id)
    const withCounters = applyCounters(existing, input)
    const next: ProjectionRunRecord = {
      ...withCounters,
      status: input.status,
      finishedAt: new Date(input.finishedAt ?? new Date()),
      errorMessage: input.status === "succeeded" ? undefined : input.errorMessage,
    }

    this.rows.set(projectionRunKey(input.projectId, input.id), structuredClone(next))
    return cloneProjectionRunRecord(next)
  }

  async getById(params: { projectId: string; id: string }): Promise<ProjectionRunRecord | null> {
    const record = this.rows.get(projectionRunKey(params.projectId, params.id))
    return record ? cloneProjectionRunRecord(record) : null
  }

  async list(input: ListProjectionRunsInput): Promise<ListProjectionRunsResult> {
    assertNonEmpty(input.projectId, "projectId")
    assertOptionalWindowValue(input.limit, "limit")
    assertOptionalWindowValue(input.offset, "offset")

    if (input.statuses && input.statuses.length === 0) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
    }

    const order = input.order ?? "desc"
    const offset = input.offset ?? 0
    const limit = input.limit ?? this.rows.size
    const statuses = input.statuses ? new Set(input.statuses) : null
    const objectTypeIds = input.objectTypeIds ? new Set(input.objectTypeIds) : null

    const filtered = [...this.rows.values()]
      .filter((record) => record.projectId === input.projectId)
      .filter((record) => (input.projectionId ? record.projectionId === input.projectionId : true))
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
      .sort((a, b) => compareRuns(a, b, order))

    const total = filtered.length
    const runs = filtered.slice(offset, offset + limit).map(cloneProjectionRunRecord)

    return {
      runs,
      hasMore: offset + runs.length < total,
      total,
    }
  }

  async listLatestByProjectionIds(
    input: ListLatestProjectionRunsInput
  ): Promise<ListLatestProjectionRunsResult> {
    const runs = latestStartedAtByOwnerId(
      [...this.rows.values()].filter((record) => record.projectId === input.projectId),
      input.projectionIds,
      (record) => record.projectionId
    )

    return { runs: runs.map(cloneProjectionRunRecord) }
  }

  private requireRunning(projectId: string, id: string): ProjectionRunRecord {
    assertNonEmpty(projectId, "projectId")
    assertNonEmpty(id, "id")

    const record = this.rows.get(projectionRunKey(projectId, id))
    if (!record) {
      throw new ProjectionRunError(
        `[Sixb] Projection run '${id}' not found for project '${projectId}'.`
      )
    }

    if (record.status !== "running") {
      throw new ProjectionRunError(
        `[Sixb] Projection run '${id}' for project '${projectId}' is already terminal.`
      )
    }

    return record
  }
}

export type InMemoryProjectionRunStorageSnapshot = Map<string, ProjectionRunRecord>
