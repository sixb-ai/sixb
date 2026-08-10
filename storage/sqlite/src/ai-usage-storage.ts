import type { Principal, ReadonlyJsonObject } from "@sixb/core/storage"
import {
  type AiModelCallUsageInput,
  type AiModelCallUsageRecord,
  type AiUsageExecutionIdentity,
  type AiUsageExecutionSummary,
  type AiUsageStorage,
  AiUsageStorageError,
  aggregateAiModelCallUsage,
  assertAiUsageExecution,
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
      executions: [input.execution],
    })
    return summary!
  }

  async summarizeExecutions(
    input: SummarizeAiUsageExecutionsInput
  ): Promise<readonly AiUsageExecutionSummary[]> {
    assertNonBlankProjectId(input.projectId)
    for (const execution of input.executions) assertAiUsageExecution(execution)
    if (input.executions.length === 0) return []

    const rows = this.executionRows(input)
    return aggregateExecutionRows(input.executions, rows)
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private insertRecord(record: AiModelCallUsageRecord): void {
    const execution = executionColumns(record.execution)
    this.connection.db
      .query(
        `
          INSERT INTO ai_model_call_usage (
            project_id,
            id,
            execution_kind,
            agent_run_id,
            workflow_run_id,
            workflow_node_run_id,
            attempt,
            call_id,
            requester_principal_type,
            requester_principal_id,
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
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `
      )
      .run(
        record.projectId,
        record.id,
        record.execution.kind,
        execution.agentRunId,
        execution.workflowRunId,
        execution.workflowNodeRunId,
        record.attempt,
        record.callId,
        record.requesterPrincipal.type,
        record.requesterPrincipal.id,
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
        record.occurredAt.toISOString(),
        record.recordedAt.toISOString()
      )
  }

  private findByIdempotencyKey(
    record: Pick<
      AiModelCallUsageRecord,
      "projectId" | "execution" | "attempt" | "callId" | "responseId"
    >
  ): AiModelCallUsageRecord | null {
    const row =
      record.execution.kind === "agentRun"
        ? (this.connection.db
            .query(
              `
                SELECT * FROM ai_model_call_usage
                WHERE project_id = ?
                  AND execution_kind = 'agentRun'
                  AND agent_run_id = ?
                  AND attempt = ?
                  AND call_id = ?
                  AND response_id = ?
              `
            )
            .get(
              record.projectId,
              record.execution.runId,
              record.attempt,
              record.callId,
              record.responseId
            ) as AiUsageRow | null)
        : (this.connection.db
            .query(
              `
                SELECT * FROM ai_model_call_usage
                WHERE project_id = ?
                  AND execution_kind = 'workflowAgentNode'
                  AND workflow_run_id = ?
                  AND workflow_node_run_id = ?
                  AND attempt = ?
                  AND call_id = ?
                  AND response_id = ?
              `
            )
            .get(
              record.projectId,
              record.execution.workflowRunId,
              record.execution.nodeRunId,
              record.attempt,
              record.callId,
              record.responseId
            ) as AiUsageRow | null)
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

    return {
      id: row.id,
      projectId: row.project_id,
      execution: executionFromRow(row),
      attempt: row.attempt,
      callId: row.call_id,
      requesterPrincipal: {
        type: row.requester_principal_type,
        id: row.requester_principal_id,
      },
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
      occurredAt: new Date(row.occurred_at),
      recordedAt: new Date(row.recorded_at),
    }
  }

  private executionRows(input: SummarizeAiUsageExecutionsInput): AiUsageRow[] {
    const requested = JSON.stringify([
      ...new Map(
        input.executions.map((execution) => [executionKey(execution), execution])
      ).values(),
    ])
    return this.connection.db
      .query(
        `
          WITH requested AS (
            SELECT DISTINCT
              json_extract(value, '$.kind') AS kind,
              json_extract(value, '$.runId') AS agent_run_id,
              json_extract(value, '$.workflowRunId') AS workflow_run_id,
              json_extract(value, '$.nodeRunId') AS workflow_node_run_id
            FROM json_each(?)
          ), requested_agent_runs AS (
            SELECT agent_run_id FROM requested WHERE kind = 'agentRun'
          ), requested_workflow_nodes AS (
            SELECT workflow_run_id, workflow_node_run_id
            FROM requested WHERE kind = 'workflowAgentNode'
          )
          SELECT usage.* FROM requested_agent_runs AS requested
          CROSS JOIN ai_model_call_usage AS usage
            ON usage.project_id = ?
            AND usage.execution_kind = 'agentRun'
            AND usage.agent_run_id = requested.agent_run_id
          UNION ALL
          SELECT usage.* FROM requested_workflow_nodes AS requested
          CROSS JOIN ai_model_call_usage AS usage
            ON usage.project_id = ?
            AND usage.execution_kind = 'workflowAgentNode'
            AND usage.workflow_run_id = requested.workflow_run_id
            AND usage.workflow_node_run_id = requested.workflow_node_run_id
        `
      )
      .all(requested, input.projectId, input.projectId) as AiUsageRow[]
  }
}

interface AiUsageRow {
  readonly project_id: string
  readonly id: string
  readonly execution_kind: AiUsageExecutionIdentity["kind"]
  readonly agent_run_id: string | null
  readonly workflow_run_id: string | null
  readonly workflow_node_run_id: string | null
  readonly attempt: number
  readonly call_id: string
  readonly requester_principal_type: Principal["type"]
  readonly requester_principal_id: string
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
  readonly occurred_at: string
  readonly recorded_at: string
}

function aggregateExecutionRows(
  executions: readonly AiUsageExecutionIdentity[],
  rows: readonly AiUsageRow[]
): readonly AiUsageExecutionSummary[] {
  const usageByExecution = new Map<string, AiModelCallUsageInput[]>()
  for (const execution of executions) usageByExecution.set(executionKey(execution), [])
  for (const row of rows) {
    usageByExecution.get(executionKey(executionFromRow(row)))?.push(usageFromRow(row))
  }
  return executions.map((execution) => {
    const usages = usageByExecution.get(executionKey(execution)) ?? []
    return {
      modelCallCount: usages.length,
      usage: aggregateAiModelCallUsage(usages),
    }
  })
}

function executionKey(execution: AiUsageExecutionIdentity): string {
  return execution.kind === "agentRun"
    ? JSON.stringify([execution.kind, execution.runId])
    : JSON.stringify([execution.kind, execution.workflowRunId, execution.nodeRunId])
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

function executionColumns(execution: AiUsageExecutionIdentity): {
  readonly agentRunId: string | null
  readonly workflowRunId: string | null
  readonly workflowNodeRunId: string | null
} {
  return execution.kind === "agentRun"
    ? { agentRunId: execution.runId, workflowRunId: null, workflowNodeRunId: null }
    : {
        agentRunId: null,
        workflowRunId: execution.workflowRunId,
        workflowNodeRunId: execution.nodeRunId,
      }
}

function executionFromRow(row: AiUsageRow): AiUsageExecutionIdentity {
  if (row.execution_kind === "agentRun" && row.agent_run_id) {
    return { kind: "agentRun", runId: row.agent_run_id }
  }
  if (
    row.execution_kind === "workflowAgentNode" &&
    row.workflow_run_id &&
    row.workflow_node_run_id
  ) {
    return {
      kind: "workflowAgentNode",
      workflowRunId: row.workflow_run_id,
      nodeRunId: row.workflow_node_run_id,
    }
  }
  throw new Error(`[SixbSqlite] AI usage record '${row.id}' has an invalid execution identity.`)
}

function assertNonBlankProjectId(projectId: string): void {
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new TypeError("[Sixb] AI usage projectId must be nonblank.")
  }
}
