import type { JsonValue } from "@sixb/core"
import { parseSixbFailure, serializeSixbFailure } from "@sixb/core/internal/errors"
import type { DatasetVersionRef } from "@sixb/core/lake-storage"
import type {
  FinishPipelineRunInput,
  FinishPipelineStepRunInput,
  ListLatestPipelineRunsInput,
  ListLatestPipelineRunsResult,
  ListPipelineRunsInput,
  ListPipelineRunsResult,
  ListPipelineStepRunsInput,
  ListPipelineStepRunsResult,
  PipelineRunRecord,
  PipelineRunStorage,
  PipelineStepRunRecord,
  StartPipelineRunInput,
  StartPipelineStepRunInput,
} from "@sixb/core/storage"
import { PIPELINE_RUN_FAILURE_CODES, PipelineRunError } from "@sixb/core/storage"
import { queryLatestRunsByOwnerId } from "./latest-run-query"
import type { SqlParameter } from "./pg-client"
import { appendRunListFilters, hasEmptyStatuses, queryRunList } from "./run-list-query"
import { isUniqueViolation } from "./storage-errors"
import { type PgStoreClient, runPgTransaction } from "./transactions"

export class PgPipelineRunStorage implements PipelineRunStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async start(input: StartPipelineRunInput): Promise<PipelineRunRecord> {
    try {
      const [row] = await this.sql<PipelineRunDatabaseRow[]>`
        INSERT INTO pipeline_runs (
          project_id,
          id,
          pipeline_id,
          status,
          started_at
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.pipelineId},
          ${"running"},
          ${input.startedAt ?? new Date()}
        )
        RETURNING *
      `

      return rowToPipelineRunRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PipelineRunError(
          `[SixbPg] Pipeline run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }
  }

  async finish(input: FinishPipelineRunInput): Promise<PipelineRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const [existing] = await tx<PipelineRunDatabaseRow[]>`
        SELECT * FROM pipeline_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
      `

      if (!existing) {
        throw new PipelineRunError(
          `[SixbPg] Pipeline run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (existing.status !== "running") {
        throw new PipelineRunError(
          `[SixbPg] Pipeline run '${input.id}' for project '${input.projectId}' is already terminal.`
        )
      }

      const [updated] =
        input.status === "succeeded"
          ? await tx<PipelineRunDatabaseRow[]>`
              UPDATE pipeline_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                output_dataset_id = ${input.output?.datasetId ?? null},
                output_version_id = ${input.output?.versionId ?? null},
                error = ${null}
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *
            `
          : await tx<PipelineRunDatabaseRow[]>`
              UPDATE pipeline_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                output_dataset_id = ${null},
                output_version_id = ${null},
                error = ${input.error === undefined ? null : serializeSixbFailure(input.error, PIPELINE_RUN_FAILURE_CODES)}::text::jsonb
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *
            `

      return rowToPipelineRunRecord(updated)
    })
  }

  async startStep(input: StartPipelineStepRunInput): Promise<PipelineStepRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const [pipelineRun] = await tx<PipelineRunDatabaseRow[]>`
        SELECT * FROM pipeline_runs
        WHERE project_id = ${input.projectId} AND id = ${input.pipelineRunId}
      `

      if (!pipelineRun) {
        throw new PipelineRunError(
          `[SixbPg] Pipeline run '${input.pipelineRunId}' not found for project '${input.projectId}'.`
        )
      }

      if (pipelineRun.status !== "running") {
        throw new PipelineRunError(
          `[SixbPg] Pipeline run '${input.pipelineRunId}' for project '${input.projectId}' is already terminal.`
        )
      }

      if (pipelineRun.pipeline_id !== input.pipelineId) {
        throw new PipelineRunError(
          `[SixbPg] Pipeline step run '${input.id}' pipeline '${input.pipelineId}' does not match pipeline run '${input.pipelineRunId}' pipeline '${pipelineRun.pipeline_id}'.`
        )
      }

      try {
        const [row] = await tx<PipelineStepRunDatabaseRow[]>`
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
          ) VALUES (
            ${input.projectId},
            ${input.id},
            ${input.pipelineRunId},
            ${input.pipelineId},
            ${input.stepId},
            ${input.datasetId},
            ${input.mode},
            ${"running"},
            ${input.startedAt ?? new Date()},
            ${JSON.stringify(input.inputs)}::text::jsonb
          )
          RETURNING *
        `

        return rowToPipelineStepRunRecord(row)
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new PipelineRunError(
            `[SixbPg] Pipeline step run '${input.id}' already exists for project '${input.projectId}'.`
          )
        }

        throw error
      }
    })
  }

  async finishStep(input: FinishPipelineStepRunInput): Promise<PipelineStepRunRecord> {
    assertOptionalNonNegativeInteger(input.rowsWritten, "rowsWritten")

    return runPgTransaction(this.sql, async (tx) => {
      const [existing] = await tx<PipelineStepRunDatabaseRow[]>`
        SELECT * FROM pipeline_step_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
      `

      if (!existing) {
        throw new PipelineRunError(
          `[SixbPg] Pipeline step run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (existing.status !== "running") {
        throw new PipelineRunError(
          `[SixbPg] Pipeline step run '${input.id}' for project '${input.projectId}' is already terminal.`
        )
      }

      if (input.status === "succeeded" && input.output.datasetId !== existing.dataset_id) {
        throw new PipelineRunError(
          `[SixbPg] Pipeline step run '${input.id}' output dataset '${input.output.datasetId}' does not match '${existing.dataset_id}'.`
        )
      }

      const [updated] =
        input.status === "succeeded"
          ? await tx<PipelineStepRunDatabaseRow[]>`
              UPDATE pipeline_step_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                output_version_id = ${input.output.versionId},
                rows_written = ${input.rowsWritten ?? existing.rows_written ?? null},
                error = ${null}
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *
            `
          : await tx<PipelineStepRunDatabaseRow[]>`
              UPDATE pipeline_step_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                output_version_id = ${null},
                rows_written = ${input.rowsWritten ?? existing.rows_written ?? null},
                error = ${input.error === undefined ? null : serializeSixbFailure(input.error, PIPELINE_RUN_FAILURE_CODES)}::text::jsonb
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *
            `

      return rowToPipelineStepRunRecord(updated)
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<PipelineRunRecord | null> {
    const [row] = await this.sql<PipelineRunDatabaseRow[]>`
      SELECT * FROM pipeline_runs
      WHERE project_id = ${params.projectId} AND id = ${params.id}
    `

    return row ? rowToPipelineRunRecord(row) : null
  }

  async list(input: ListPipelineRunsInput): Promise<ListPipelineRunsResult> {
    if (hasEmptyStatuses(input) || input.pipelineIds?.length === 0) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
    }

    const whereClauses = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2

    if (input.pipelineId) {
      whereClauses.push(`pipeline_id = $${index++}`)
      params.push(input.pipelineId)
    }

    if (input.pipelineIds) {
      const placeholders = input.pipelineIds.map(() => `$${index++}`).join(", ")
      whereClauses.push(`pipeline_id IN (${placeholders})`)
      params.push(...input.pipelineIds)
    }

    index = appendRunListFilters(whereClauses, params, index, input)

    const { rows, total, hasMore } = await queryRunList<PipelineRunDatabaseRow>({
      sql: this.sql,
      tableName: "pipeline_runs",
      whereClauses,
      params,
      nextIndex: index,
      order: input.order,
      limit: input.limit,
      offset: input.offset,
    })
    const runs = rows.map(rowToPipelineRunRecord)

    return {
      runs,
      hasMore,
      total,
    }
  }

  async listLatestByPipelineIds(
    input: ListLatestPipelineRunsInput
  ): Promise<ListLatestPipelineRunsResult> {
    const rows = await queryLatestRunsByOwnerId<PipelineRunDatabaseRow>({
      sql: this.sql,
      tableName: "pipeline_runs",
      ownerColumn: "pipeline_id",
      ownerIds: input.pipelineIds,
      projectId: input.projectId,
      ownerIdFor: (row) => row.pipeline_id,
    })

    return {
      runs: rows.map(rowToPipelineRunRecord),
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

    const whereClauses = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2

    if (input.pipelineRunId) {
      whereClauses.push(`pipeline_run_id = $${index++}`)
      params.push(input.pipelineRunId)
    }

    if (input.pipelineId) {
      whereClauses.push(`pipeline_id = $${index++}`)
      params.push(input.pipelineId)
    }

    if (input.stepId) {
      whereClauses.push(`step_id = $${index++}`)
      params.push(input.stepId)
    }

    if (input.datasetId) {
      whereClauses.push(`dataset_id = $${index++}`)
      params.push(input.datasetId)
    }

    index = appendRunListFilters(whereClauses, params, index, input)

    const { rows, total, hasMore } = await queryRunList<PipelineStepRunDatabaseRow>({
      sql: this.sql,
      tableName: "pipeline_step_runs",
      whereClauses,
      params,
      nextIndex: index,
      order: input.order,
      limit: input.limit,
      offset: input.offset,
    })
    const steps = rows.map(rowToPipelineStepRunRecord)

    return {
      steps,
      hasMore,
      total,
    }
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
    error: row.error === null ? undefined : parseSixbFailure(row.error, PIPELINE_RUN_FAILURE_CODES),
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
    rowsWritten: row.rows_written != null ? Number(row.rows_written) : undefined,
    error: row.error === null ? undefined : parseSixbFailure(row.error, PIPELINE_RUN_FAILURE_CODES),
  }
}

function parseDatasetVersionRefs(
  value: readonly DatasetVersionRef[] | string
): readonly DatasetVersionRef[] {
  return typeof value === "string" ? (JSON.parse(value) as readonly DatasetVersionRef[]) : value
}

function assertOptionalNonNegativeInteger(value: number | undefined, fieldName: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new PipelineRunError(`[SixbPg] Pipeline run ${fieldName} must be a non-negative integer.`)
  }
}

interface PipelineRunDatabaseRow {
  project_id: string
  id: string
  pipeline_id: string
  status: PipelineRunRecord["status"]
  started_at: Date | string
  finished_at: Date | string | null
  output_dataset_id: string | null
  output_version_id: string | null
  error: JsonValue | null
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
  started_at: Date | string
  finished_at: Date | string | null
  inputs: readonly DatasetVersionRef[] | string
  output_version_id: string | null
  rows_written: number | string | null
  error: JsonValue | null
}
