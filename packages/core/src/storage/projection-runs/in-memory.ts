import { ProjectionRunError } from "./errors"
import type {
  FinishProjectionRunInput,
  ListProjectionRunsInput,
  ListProjectionRunsResult,
  ProjectionRunCounters,
  ProjectionRunRecord,
  ProjectionRunStorage,
  StartProjectionRunInput,
  UpdateProjectionRunInput,
} from "./types"

type CounterKey = keyof ProjectionRunCounters

const counterKeys: readonly CounterKey[] = [
  "rowsProcessed",
  "rowsSkipped",
  "objectsUpserted",
  "linksUpserted",
]

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
  for (const key of counterKeys) {
    assertOptionalCounter(input[key], key)
  }

  return {
    ...record,
    rowsProcessed: input.rowsProcessed ?? record.rowsProcessed,
    rowsSkipped: input.rowsSkipped ?? record.rowsSkipped,
    objectsUpserted: input.objectsUpserted ?? record.objectsUpserted,
    linksUpserted: input.linksUpserted ?? record.linksUpserted,
  }
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
      status: "running",
      startedAt: new Date(input.startedAt ?? new Date()),
      rowsProcessed: 0,
      rowsSkipped: 0,
      objectsUpserted: 0,
      linksUpserted: 0,
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
