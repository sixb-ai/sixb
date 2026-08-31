import type { ReadonlyJsonObject } from "@sixb/core/storage"
import {
  type AiModelCallUsageInput,
  type AiModelCallUsageRecord,
  type AiUsageExecutionSummary,
  type AiUsageStorage,
  AiUsageStorageError,
  aggregateAiModelCallUsage,
  assertAiUsageExecutionId,
  normalizeAiModelCallRecord,
  type RecordAiModelCallInput,
  type RecordAiModelCallResult,
  type SummarizeAiUsageExecutionInput,
  type SummarizeAiUsageExecutionsInput,
} from "@sixb/core/storage"
import { installFreshSqliteSchema } from "./migrations"
import { isUniqueConstraintError } from "./storage-errors"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  runImmediateTransaction,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteAiUsageStorageOptions {
  readonly path?: string
  readonly connection?: SqliteStoreConnection
}

/** SQLite-backed append-only model-call usage ledger. */
export class SqliteAiUsageStorage implements AiUsageStorage {
  private readonly connection: SqliteStoreConnection

  constructor(options: SqliteAiUsageStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.connection.db)
    }
  }

  async recordModelCall(input: RecordAiModelCallInput): Promise<RecordAiModelCallResult> {
    const record = normalizeAiModelCallRecord(input)
    return runImmediateTransaction(this.connection.db, () => {
      const existing = this.findByIdempotencyKey(record)
      if (existing) return { record: existing, created: false }
      this.assertExecutionExists(record.projectId, record.executionId)

      try {
        this.insertRecord(record)
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error

        const concurrent = this.findByIdempotencyKey(record)
        if (concurrent) return { record: concurrent, created: false }
        throw new AiUsageStorageError(
          "duplicate_id",
          `[SixbSqlite] AI usage record '${record.id}' already exists for project '${record.projectId}'.`
        )
      }

      for (const groupId of record.requesterGroupIds) {
        this.connection.db
          .query(
            `
              INSERT INTO ai_model_call_usage_groups (
                project_id, usage_record_id, group_id, occurred_at
              ) VALUES (?, ?, ?, ?)
            `
          )
          .run(record.projectId, record.id, groupId, record.occurredAt.toISOString())
      }

      return { record: this.requireById(record.projectId, record.id), created: true }
    })
  }

  async summarizeExecution(
    input: SummarizeAiUsageExecutionInput
  ): Promise<AiUsageExecutionSummary> {
    const [summary] = await this.summarizeExecutions({
      projectId: input.projectId,
      executionIds: [input.executionId],
    })
    return summary!
  }

  async summarizeExecutions(
    input: SummarizeAiUsageExecutionsInput
  ): Promise<readonly AiUsageExecutionSummary[]> {
    assertNonBlankProjectId(input.projectId)
    for (const executionId of input.executionIds) assertAiUsageExecutionId(executionId)
    if (input.executionIds.length === 0) return []

    const rows = this.executionRows(input)
    return aggregateExecutionRows(input.executionIds, rows)
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private insertRecord(record: AiModelCallUsageRecord): void {
    this.connection.db
      .query(
        `
          INSERT INTO ai_model_call_usage (
            project_id,
            id,
            execution_id,
            attempt,
            call_id,
            provider_id,
            requested_model_id,
            response_model_id,
            response_id,
            input_tokens,
            output_tokens,
            total_tokens,
            uncached_input_tokens,
            cache_read_input_tokens,
            cache_write_input_tokens,
            text_output_tokens,
            reasoning_output_tokens,
            reporting_status,
            raw_usage,
            model_definition,
            cost,
            route,
            occurred_at,
            recorded_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `
      )
      .run(
        record.projectId,
        record.id,
        record.executionId,
        record.attempt,
        record.callId,
        record.providerId,
        record.requestedModelId,
        record.responseModelId ?? null,
        record.responseId,
        record.usage.inputTokens ?? null,
        record.usage.outputTokens ?? null,
        record.usage.totalTokens ?? null,
        record.usage.uncachedInputTokens ?? null,
        record.usage.cacheReadInputTokens ?? null,
        record.usage.cacheWriteInputTokens ?? null,
        record.usage.textOutputTokens ?? null,
        record.usage.reasoningOutputTokens ?? null,
        record.usage.reportingStatus,
        record.rawUsage === undefined ? null : JSON.stringify(record.rawUsage),
        record.modelDefinition === undefined ? null : JSON.stringify(record.modelDefinition),
        record.cost === undefined ? null : JSON.stringify(record.cost),
        record.route === undefined ? null : JSON.stringify(record.route),
        record.occurredAt.toISOString(),
        record.recordedAt.toISOString()
      )
  }

  private findByIdempotencyKey(
    record: Pick<
      AiModelCallUsageRecord,
      "projectId" | "executionId" | "attempt" | "callId" | "responseId"
    >
  ): AiModelCallUsageRecord | null {
    const row = this.connection.db
      .query(
        `
          SELECT * FROM ai_model_call_usage
          WHERE project_id = ?
            AND execution_id = ?
            AND attempt = ?
            AND call_id = ?
            AND response_id = ?
        `
      )
      .get(
        record.projectId,
        record.executionId,
        record.attempt,
        record.callId,
        record.responseId
      ) as AiUsageRow | null
    return row ? this.rowToRecord(row) : null
  }

  private requireById(projectId: string, id: string): AiModelCallUsageRecord {
    const row = this.connection.db
      .query("SELECT * FROM ai_model_call_usage WHERE project_id = ? AND id = ?")
      .get(projectId, id) as AiUsageRow | null
    if (!row) throw new Error(`[SixbSqlite] AI usage record '${id}' disappeared after insert.`)
    return this.rowToRecord(row)
  }

  private rowToRecord(row: AiUsageRow): AiModelCallUsageRecord {
    const groupRows = this.connection.db
      .query(
        `
          SELECT group_id FROM ai_model_call_usage_groups
          WHERE project_id = ? AND usage_record_id = ?
          ORDER BY group_id
        `
      )
      .all(row.project_id, row.id) as Array<{ group_id: string }>
    const modelDefinition = jsonFromRow<NonNullable<AiModelCallUsageRecord["modelDefinition"]>>(
      row.model_definition
    )
    const cost = jsonFromRow<NonNullable<AiModelCallUsageRecord["cost"]>>(row.cost)
    const route = jsonFromRow<NonNullable<AiModelCallUsageRecord["route"]>>(row.route)

    return {
      id: row.id,
      projectId: row.project_id,
      executionId: row.execution_id,
      attempt: row.attempt,
      callId: row.call_id,
      requesterGroupIds: groupRows.map((group) => group.group_id),
      providerId: row.provider_id,
      requestedModelId: row.requested_model_id,
      ...(row.response_model_id === null ? {} : { responseModelId: row.response_model_id }),
      responseId: row.response_id,
      usage: {
        ...usageFromRow(row),
        ...(row.total_tokens === null ? {} : { totalTokens: row.total_tokens }),
        reportingStatus: row.reporting_status,
      },
      ...(row.raw_usage === null
        ? {}
        : { rawUsage: JSON.parse(row.raw_usage) as ReadonlyJsonObject }),
      ...(modelDefinition === undefined ? {} : { modelDefinition }),
      ...(cost === undefined ? {} : { cost }),
      ...(route === undefined ? {} : { route }),
      occurredAt: new Date(row.occurred_at),
      recordedAt: new Date(row.recorded_at),
    }
  }

  private executionRows(input: SummarizeAiUsageExecutionsInput): AiUsageRow[] {
    const requested = JSON.stringify([...new Set(input.executionIds)])
    return this.connection.db
      .query(
        `
          WITH requested AS (
            SELECT DISTINCT value AS execution_id
            FROM json_each(?)
          )
          SELECT usage.* FROM requested
          JOIN ai_model_call_usage AS usage
            ON usage.project_id = ?
            AND usage.execution_id = requested.execution_id
        `
      )
      .all(requested, input.projectId) as AiUsageRow[]
  }

  private assertExecutionExists(projectId: string, executionId: string): void {
    const execution = this.connection.db
      .query("SELECT 1 FROM executions WHERE project_id = ? AND id = ?")
      .get(projectId, executionId)
    if (execution) return
    throw new AiUsageStorageError(
      "missing_execution",
      `[SixbSqlite] AI usage execution '${executionId}' does not exist in project '${projectId}'.`
    )
  }
}

interface AiUsageRow {
  readonly project_id: string
  readonly id: string
  readonly execution_id: string
  readonly attempt: number
  readonly call_id: string
  readonly provider_id: string
  readonly requested_model_id: string
  readonly response_model_id: string | null
  readonly response_id: string
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly total_tokens: number | null
  readonly uncached_input_tokens: number | null
  readonly cache_read_input_tokens: number | null
  readonly cache_write_input_tokens: number | null
  readonly text_output_tokens: number | null
  readonly reasoning_output_tokens: number | null
  readonly reporting_status: AiModelCallUsageRecord["usage"]["reportingStatus"]
  readonly raw_usage: string | null
  readonly model_definition: string | null
  readonly cost: string | null
  readonly route: string | null
  readonly occurred_at: string
  readonly recorded_at: string
}

function jsonFromRow<T>(value: string | null): T | undefined {
  return value === null ? undefined : (JSON.parse(value) as T)
}

function aggregateExecutionRows(
  executionIds: readonly string[],
  rows: readonly AiUsageRow[]
): readonly AiUsageExecutionSummary[] {
  const usageByExecutionId = new Map<string, AiModelCallUsageInput[]>()
  for (const executionId of executionIds) usageByExecutionId.set(executionId, [])
  for (const row of rows) {
    usageByExecutionId.get(row.execution_id)?.push(usageFromRow(row))
  }
  return executionIds.map((executionId) => {
    const usages = usageByExecutionId.get(executionId) ?? []
    return {
      modelCallCount: usages.length,
      usage: aggregateAiModelCallUsage(usages),
    }
  })
}

function usageFromRow(row: AiUsageRow): AiModelCallUsageInput {
  return {
    ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
    ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
    ...(row.uncached_input_tokens === null
      ? {}
      : { uncachedInputTokens: row.uncached_input_tokens }),
    ...(row.cache_read_input_tokens === null
      ? {}
      : { cacheReadInputTokens: row.cache_read_input_tokens }),
    ...(row.cache_write_input_tokens === null
      ? {}
      : { cacheWriteInputTokens: row.cache_write_input_tokens }),
    ...(row.text_output_tokens === null ? {} : { textOutputTokens: row.text_output_tokens }),
    ...(row.reasoning_output_tokens === null
      ? {}
      : { reasoningOutputTokens: row.reasoning_output_tokens }),
  }
}

function assertNonBlankProjectId(projectId: string): void {
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new TypeError("[Sixb] AI usage projectId must be nonblank.")
  }
}
