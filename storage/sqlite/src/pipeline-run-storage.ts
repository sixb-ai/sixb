import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type {
  DatasetVersionRef,
  FinishPipelineRunInput,
  FinishPipelineStepRunInput,
  ListPipelineRunsInput,
  ListPipelineRunsResult,
  ListPipelineStepRunsInput,
  ListPipelineStepRunsResult,
  PipelineRunFailure,
  PipelineRunRecord,
  PipelineRunStorage,
  PipelineStepRunRecord,
  StartPipelineRunInput,
  StartPipelineStepRunInput,
} from "@sixb/core"
import { PipelineRunError } from "@sixb/core"
import { installFreshSqliteSchema } from "./migrations"
import {
  appendRunListFilters,
  hasEmptyStatuses,
  queryRunList,
  type SqliteValue,
} from "./run-list-query"
import { isUniqueConstraintError } from "./storage-errors"

export interface SqlitePipelineRunStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
}

export class SqlitePipelineRunStorage implements PipelineRunStorage {
  private readonly db: Database

  constructor(options: SqlitePipelineRunStorageOptions = {}) {
    const path = options.path ?? ":memory:"
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)

    if (path === ":memory:") {
      installFreshSqliteSchema(this.db)
    }
  }

  async start(input: StartPipelineRunInput): Promise<PipelineRunRecord> {
    const startedAt = input.startedAt ?? new Date()

    try {
      this.db
        .query(
          `
          INSERT INTO pipeline_runs (
            project_id,
            id,
            pipeline_id,
            status,
            started_at
          ) VALUES (?, ?, ?, ?, ?)
        `
        )
        .run(input.projectId, input.id, input.pipelineId, "running", startedAt.toISOString())
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new PipelineRunError(
          `[SixbSqlite] Pipeline run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }

    const record = await this.getById({ projectId: input.projectId, id: input.id })
    if (!record) {
      throw new PipelineRunError(
        `[SixbSqlite] Failed to load pipeline run '${input.id}' for project '${input.projectId}'.`
      )
    }

    return record
  }

  async finish(input: FinishPipelineRunInput): Promise<PipelineRunRecord> {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM pipeline_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as PipelineRunDatabaseRow | null

      if (!existing) {
        throw new PipelineRunError(
          `[SixbSqlite] Pipeline run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (existing.status !== "running") {
        throw new PipelineRunError(
          `[SixbSqlite] Pipeline run '${input.id}' for project '${input.projectId}' is already terminal.`
        )
      }

      this.db
        .query(
          `
          UPDATE pipeline_runs
          SET
            status = ?,
            finished_at = ?,
            output_dataset_id = ?,
            output_version_id = ?,
            error_name = ?,
            error_message = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          input.status,
          (input.finishedAt ?? new Date()).toISOString(),
          input.status === "succeeded" ? (input.output?.datasetId ?? null) : null,
          input.status === "succeeded" ? (input.output?.versionId ?? null) : null,
          input.status === "succeeded" ? null : (input.error?.name ?? null),
          input.status === "succeeded" ? null : (input.error?.message ?? null),
          input.projectId,
          input.id
        )

      const updated = this.db
        .query("SELECT * FROM pipeline_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as PipelineRunDatabaseRow

      return rowToPipelineRunRecord(updated)
    })()
  }

  async startStep(input: StartPipelineStepRunInput): Promise<PipelineStepRunRecord> {
    return this.db.transaction(() => {
      const pipelineRun = this.db
        .query("SELECT * FROM pipeline_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.pipelineRunId) as PipelineRunDatabaseRow | null

      if (!pipelineRun) {
        throw new PipelineRunError(
          `[SixbSqlite] Pipeline run '${input.pipelineRunId}' not found for project '${input.projectId}'.`
        )
      }

      if (pipelineRun.status !== "running") {
        throw new PipelineRunError(
          `[SixbSqlite] Pipeline run '${input.pipelineRunId}' for project '${input.projectId}' is already terminal.`
        )
      }

      if (pipelineRun.pipeline_id !== input.pipelineId) {
        throw new PipelineRunError(
          `[SixbSqlite] Pipeline step run '${input.id}' pipeline '${input.pipelineId}' does not match pipeline run '${input.pipelineRunId}' pipeline '${pipelineRun.pipeline_id}'.`
        )
      }

      const startedAt = input.startedAt ?? new Date()

      try {
        this.db
          .query(
            `
            INSERT INTO pipeline_step_runs (
              project_id,
              id,
              pipeline_run_id,
              pipeline_id,
              step_id,
              dataset_id,
              mode,
              status,
              started_at,
              inputs
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          )
          .run(
            input.projectId,
            input.id,
            input.pipelineRunId,
            input.pipelineId,
            input.stepId,
            input.datasetId,
            input.mode,
            "running",
            startedAt.toISOString(),
            serializeDatasetVersionRefs(input.inputs)
          )
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new PipelineRunError(
            `[SixbSqlite] Pipeline step run '${input.id}' already exists for project '${input.projectId}'.`
          )
        }

        throw error
      }

      const row = this.db
        .query("SELECT * FROM pipeline_step_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as PipelineStepRunDatabaseRow | null

      if (!row) {
        throw new PipelineRunError(
          `[SixbSqlite] Failed to load pipeline step run '${input.id}' for project '${input.projectId}'.`
        )
      }

      return rowToPipelineStepRunRecord(row)
    })()
  }

  async finishStep(input: FinishPipelineStepRunInput): Promise<PipelineStepRunRecord> {
    assertOptionalNonNegativeInteger(input.rowsWritten, "rowsWritten")

    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM pipeline_step_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as PipelineStepRunDatabaseRow | null

      if (!existing) {
        throw new PipelineRunError(
          `[SixbSqlite] Pipeline step run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (existing.status !== "running") {
        throw new PipelineRunError(
          `[SixbSqlite] Pipeline step run '${input.id}' for project '${input.projectId}' is already terminal.`
        )
      }

      if (input.status === "succeeded" && input.output.datasetId !== existing.dataset_id) {
        throw new PipelineRunError(
          `[SixbSqlite] Pipeline step run '${input.id}' output dataset '${input.output.datasetId}' does not match '${existing.dataset_id}'.`
        )
      }

      this.db
        .query(
          `
          UPDATE pipeline_step_runs
          SET
            status = ?,
            finished_at = ?,
            output_version_id = ?,
            rows_written = ?,
            error_name = ?,
            error_message = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          input.status,
          (input.finishedAt ?? new Date()).toISOString(),
          input.status === "succeeded" ? input.output.versionId : null,
          input.rowsWritten ?? existing.rows_written ?? null,
          input.status === "succeeded" ? null : (input.error?.name ?? null),
          input.status === "succeeded" ? null : (input.error?.message ?? null),
          input.projectId,
          input.id
        )

      const updated = this.db
        .query("SELECT * FROM pipeline_step_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as PipelineStepRunDatabaseRow

      return rowToPipelineStepRunRecord(updated)
    })()
  }

  async getById(params: { projectId: string; id: string }): Promise<PipelineRunRecord | null> {
    const row = this.db
      .query("SELECT * FROM pipeline_runs WHERE project_id = ? AND id = ?")
      .get(params.projectId, params.id) as PipelineRunDatabaseRow | null

    return row ? rowToPipelineRunRecord(row) : null
  }

  async list(input: ListPipelineRunsInput): Promise<ListPipelineRunsResult> {
    if (hasEmptyStatuses(input)) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
    }

    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]

    if (input.pipelineId) {
      whereClauses.push("pipeline_id = ?")
      args.push(input.pipelineId)
    }

    appendRunListFilters(whereClauses, args, input)

    const { rows, total, hasMore } = queryRunList<PipelineRunDatabaseRow>({
      db: this.db,
      tableName: "pipeline_runs",
      whereClauses,
      args,
      order: input.order,
      limit: input.limit,
      offset: input.offset,
    })

    return {
      runs: rows.map(rowToPipelineRunRecord),
      hasMore,
      total,
    }
  }

  async listSteps(input: ListPipelineStepRunsInput): Promise<ListPipelineStepRunsResult> {
    if (hasEmptyStatuses(input)) {
      return {
        steps: [],
        hasMore: false,
        total: 0,
      }
    }

    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]

    if (input.pipelineRunId) {
      whereClauses.push("pipeline_run_id = ?")
      args.push(input.pipelineRunId)
    }

    if (input.pipelineId) {
      whereClauses.push("pipeline_id = ?")
      args.push(input.pipelineId)
    }

    if (input.stepId) {
      whereClauses.push("step_id = ?")
      args.push(input.stepId)
    }

    if (input.datasetId) {
      whereClauses.push("dataset_id = ?")
      args.push(input.datasetId)
    }

    appendRunListFilters(whereClauses, args, input)

    const { rows, total, hasMore } = queryRunList<PipelineStepRunDatabaseRow>({
      db: this.db,
      tableName: "pipeline_step_runs",
      whereClauses,
      args,
      order: input.order,
      limit: input.limit,
      offset: input.offset,
    })

    return {
      steps: rows.map(rowToPipelineStepRunRecord),
      hasMore,
      total,
    }
  }

  close(): void {
    this.db.close()
  }
}

function serializeDatasetVersionRefs(refs: readonly DatasetVersionRef[]): string {
  return JSON.stringify(refs)
}

function parseDatasetVersionRefs(value: string): readonly DatasetVersionRef[] {
  return JSON.parse(value) as readonly DatasetVersionRef[]
}

function toFailure(row: {
  readonly error_name: string | null
  readonly error_message: string | null
}): PipelineRunFailure | undefined {
  if (!row.error_message) {
    return undefined
  }

  return {
    name: row.error_name ?? undefined,
    message: row.error_message,
  }
}

function rowToPipelineRunRecord(row: PipelineRunDatabaseRow): PipelineRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    pipelineId: row.pipeline_id,
    status: row.status,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    output:
      row.output_dataset_id && row.output_version_id
        ? {
            datasetId: row.output_dataset_id,
            versionId: row.output_version_id,
          }
        : undefined,
    error: toFailure(row),
  }
}

function rowToPipelineStepRunRecord(row: PipelineStepRunDatabaseRow): PipelineStepRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    pipelineRunId: row.pipeline_run_id,
    pipelineId: row.pipeline_id,
    stepId: row.step_id,
    datasetId: row.dataset_id,
    mode: row.mode,
    status: row.status,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    inputs: parseDatasetVersionRefs(row.inputs),
    output: row.output_version_id
      ? {
          datasetId: row.dataset_id,
          versionId: row.output_version_id,
        }
      : undefined,
    rowsWritten: row.rows_written ?? undefined,
    error: toFailure(row),
  }
}

function assertOptionalNonNegativeInteger(value: number | undefined, fieldName: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new PipelineRunError(
      `[SixbSqlite] Pipeline run ${fieldName} must be a non-negative integer.`
    )
  }
}

interface PipelineRunDatabaseRow {
  project_id: string
  id: string
  pipeline_id: string
  status: PipelineRunRecord["status"]
  started_at: string
  finished_at: string | null
  output_dataset_id: string | null
  output_version_id: string | null
  error_name: string | null
  error_message: string | null
}

interface PipelineStepRunDatabaseRow {
  project_id: string
  id: string
  pipeline_run_id: string
  pipeline_id: string
  step_id: string
  dataset_id: string
  mode: PipelineStepRunRecord["mode"]
  status: PipelineStepRunRecord["status"]
  started_at: string
  finished_at: string | null
  inputs: string
  output_version_id: string | null
  rows_written: number | null
  error_name: string | null
  error_message: string | null
}
