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
import type { SQLClient } from "./pg-client"
import { type PgStoreClient, runPgTransaction } from "./transactions"

/** PostgreSQL-backed append-only model-call usage ledger. */
export class PgAiUsageStorage implements AiUsageStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async recordModelCall(input: RecordAiModelCallInput): Promise<RecordAiModelCallResult> {
    const record = normalizeAiModelCallRecord(input)
    return runPgTransaction(this.sql, async (tx) => {
      const existing = await this.findByIdempotencyKey(tx, record)
      if (existing) return { record: existing, created: false }
      await this.assertExecutionExists(tx, record.projectId, record.executionId)

      const inserted = await tx<{ id: string }[]>`
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
          occurred_at,
          recorded_at
        ) VALUES (
          ${record.projectId},
          ${record.id},
          ${record.executionId},
          ${record.attempt},
          ${record.callId},
          ${record.providerId},
          ${record.requestedModelId},
          ${record.responseModelId ?? null},
          ${record.responseId},
          ${record.usage.inputTokens ?? null},
          ${record.usage.outputTokens ?? null},
          ${record.usage.totalTokens ?? null},
          ${record.usage.uncachedInputTokens ?? null},
          ${record.usage.cacheReadInputTokens ?? null},
          ${record.usage.cacheWriteInputTokens ?? null},
          ${record.usage.textOutputTokens ?? null},
          ${record.usage.reasoningOutputTokens ?? null},
          ${record.usage.reportingStatus},
          ${record.rawUsage === undefined ? null : JSON.stringify(record.rawUsage)}::text::jsonb,
          ${record.occurredAt},
          ${record.recordedAt}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `

      if (inserted.length === 0) {
        const concurrent = await this.findByIdempotencyKey(tx, record)
        if (concurrent) return { record: concurrent, created: false }
        throw new AiUsageStorageError(
          "duplicate_id",
          `[SixbPg] AI usage record '${record.id}' already exists for project '${record.projectId}'.`
        )
      }

      for (const groupId of record.requesterGroupIds) {
        await tx`
          INSERT INTO ai_model_call_usage_groups (
            project_id, usage_record_id, group_id, occurred_at
          ) VALUES (
            ${record.projectId}, ${record.id}, ${groupId}, ${record.occurredAt}
          )
        `
      }

      return { record: await this.requireById(tx, record.projectId, record.id), created: true }
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

    const rows = await this.executionRows(this.sql, input)
    return aggregateExecutionRows(input.executionIds, rows)
  }

  private async findByIdempotencyKey(
    sql: PgStoreClient,
    record: Pick<
      AiModelCallUsageRecord,
      "projectId" | "executionId" | "attempt" | "callId" | "responseId"
    >
  ): Promise<AiModelCallUsageRecord | null> {
    const rows = await sql<AiUsageRow[]>`
      SELECT * FROM ai_model_call_usage
      WHERE project_id = ${record.projectId}
        AND execution_id = ${record.executionId}
        AND attempt = ${record.attempt}
        AND call_id = ${record.callId}
        AND response_id = ${record.responseId}
    `
    return rows[0] ? this.rowToRecord(sql, rows[0]) : null
  }

  private async requireById(
    sql: SQLClient,
    projectId: string,
    id: string
  ): Promise<AiModelCallUsageRecord> {
    const [row] = await sql<AiUsageRow[]>`
      SELECT * FROM ai_model_call_usage WHERE project_id = ${projectId} AND id = ${id}
    `
    if (!row) throw new Error(`[SixbPg] AI usage record '${id}' disappeared after insert.`)
    return this.rowToRecord(sql, row)
  }

  private async rowToRecord(sql: PgStoreClient, row: AiUsageRow): Promise<AiModelCallUsageRecord> {
    const groupRows = await sql<Array<{ group_id: string }>>`
      SELECT group_id FROM ai_model_call_usage_groups
      WHERE project_id = ${row.project_id} AND usage_record_id = ${row.id}
      ORDER BY group_id
    `

    return {
      id: row.id,
      projectId: row.project_id,
      executionId: row.execution_id,
      attempt: Number(row.attempt),
      callId: row.call_id,
      requesterGroupIds: groupRows.map((group) => group.group_id),
      providerId: row.provider_id,
      requestedModelId: row.requested_model_id,
      ...(row.response_model_id === null ? {} : { responseModelId: row.response_model_id }),
      responseId: row.response_id,
      usage: {
        ...usageFromRow(row),
        ...(row.total_tokens === null ? {} : { totalTokens: Number(row.total_tokens) }),
        reportingStatus: row.reporting_status,
      },
      ...(row.raw_usage === null ? {} : { rawUsage: rawUsageFromRow(row.raw_usage) }),
      occurredAt: new Date(row.occurred_at),
      recordedAt: new Date(row.recorded_at),
    }
  }

  private executionRows(
    sql: PgStoreClient,
    input: SummarizeAiUsageExecutionsInput
  ): Promise<AiUsageRow[]> {
    const executionIds = [...new Set(input.executionIds)]

    return sql<AiUsageRow[]>`
      WITH requested(execution_id) AS (
        SELECT * FROM unnest(${sql.array(executionIds)}::text[])
      )
      SELECT usage.* FROM requested
      JOIN ai_model_call_usage AS usage
        ON usage.project_id = ${input.projectId}
        AND usage.execution_id = requested.execution_id
    `
  }

  private async assertExecutionExists(
    sql: PgStoreClient,
    projectId: string,
    executionId: string
  ): Promise<void> {
    const [execution] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM executions WHERE project_id = ${projectId} AND id = ${executionId}
      ) AS exists
    `
    if (execution?.exists) return
    throw new AiUsageStorageError(
      "missing_execution",
      `[SixbPg] AI usage execution '${executionId}' does not exist in project '${projectId}'.`
    )
  }
}

interface AiUsageRow {
  readonly project_id: string
  readonly id: string
  readonly execution_id: string
  readonly attempt: number | string
  readonly call_id: string
  readonly provider_id: string
  readonly requested_model_id: string
  readonly response_model_id: string | null
  readonly response_id: string
  readonly input_tokens: number | string | null
  readonly output_tokens: number | string | null
  readonly total_tokens: number | string | null
  readonly uncached_input_tokens: number | string | null
  readonly cache_read_input_tokens: number | string | null
  readonly cache_write_input_tokens: number | string | null
  readonly text_output_tokens: number | string | null
  readonly reasoning_output_tokens: number | string | null
  readonly reporting_status: AiModelCallUsageRecord["usage"]["reportingStatus"]
  readonly raw_usage: ReadonlyJsonObject | string | null
  readonly occurred_at: Date | string
  readonly recorded_at: Date | string
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
    ...(row.input_tokens === null ? {} : { inputTokens: Number(row.input_tokens) }),
    ...(row.output_tokens === null ? {} : { outputTokens: Number(row.output_tokens) }),
    ...(row.uncached_input_tokens === null
      ? {}
      : { uncachedInputTokens: Number(row.uncached_input_tokens) }),
    ...(row.cache_read_input_tokens === null
      ? {}
      : { cacheReadInputTokens: Number(row.cache_read_input_tokens) }),
    ...(row.cache_write_input_tokens === null
      ? {}
      : { cacheWriteInputTokens: Number(row.cache_write_input_tokens) }),
    ...(row.text_output_tokens === null
      ? {}
      : { textOutputTokens: Number(row.text_output_tokens) }),
    ...(row.reasoning_output_tokens === null
      ? {}
      : { reasoningOutputTokens: Number(row.reasoning_output_tokens) }),
  }
}

function rawUsageFromRow(value: Exclude<AiUsageRow["raw_usage"], null>): ReadonlyJsonObject {
  return typeof value === "string" ? (JSON.parse(value) as ReadonlyJsonObject) : value
}

function assertNonBlankProjectId(projectId: string): void {
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new TypeError("[Sixb] AI usage projectId must be nonblank.")
  }
}
