import {
  type AiAccountingAggregateFragment,
  type AiAccountingRecordSetItem,
  aiModelCallCostDetails,
  aiModelCallCostMatchesUsage,
  buildAiAccountingOverviewFromFragments,
  normalizeAiAccountingQuery,
  normalizeAiModelCallAccountingQuery,
  normalizeAiModelCallCostRecord,
  parseAiModelCallCostDetails,
  toAccountingItem,
} from "@sixb/core/internal/ai-cost-storage-provider"
import type { ReadonlyJsonObject } from "@sixb/core/storage"
import {
  type AiAccountingOverview,
  type AiCostStorage,
  AiCostStorageError,
  type AiCostSummary,
  type AiModelCallCostRecord,
  type AiModelCallUsageRecord,
  type ListAiModelCallAccountingInput,
  type ListAiModelCallAccountingResult,
  type ListAiModelCallGroupsInput,
  type ListAiModelCallGroupsResult,
  type QueryAiAccountingOverviewInput,
  type SummarizeAiCostExecutionsInput,
} from "@sixb/core/storage"
import { listAiModelCallGroups } from "./ai-cost-groups"
import { isUniqueConstraintError } from "./storage-errors"
import { runImmediateTransaction, type SqliteStoreConnection } from "./transactions"

/** SQLite-backed immutable valuations stored in one append-only table. */
export class SqliteAiCostStorage implements AiCostStorage {
  constructor(private readonly connection: SqliteStoreConnection) {}

  async listModelCallGroups(
    input: ListAiModelCallGroupsInput
  ): Promise<ListAiModelCallGroupsResult> {
    return listAiModelCallGroups(this.connection, input)
  }

  async recordModelCallCost(input: AiModelCallCostRecord): Promise<void> {
    const record = normalizeAiModelCallCostRecord(input)
    runImmediateTransaction(this.connection.db, () => {
      const usage = this.findUsage(record.projectId, record.usageRecordId)
      if (!usage) throw missingUsage(record)
      assertCostMatchesUsage(record, usage)
      if (this.findCost(record.projectId, record.usageRecordId)) return
      try {
        this.insertCost(record)
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error
        if (!this.findCost(record.projectId, record.usageRecordId)) throw error
      }
    })
  }

  async summarizeExecutions(
    input: SummarizeAiCostExecutionsInput
  ): Promise<readonly AiCostSummary[]> {
    assertNonBlank(input.projectId, "cost summary projectId")
    for (const id of input.executionIds) assertNonBlank(id, "cost summary executionId")
    if (input.executionIds.length === 0) return []
    const rows = this.connection.db
      .query(
        `
          WITH requested AS (SELECT DISTINCT value AS execution_id FROM json_each(?))
          SELECT usage.execution_id,
            cost.status,
            cost.currency,
            CAST(cost.amount_nanos AS TEXT) AS amount_nanos
          FROM requested
          JOIN ai_model_call_usage AS usage
            ON usage.project_id = ? AND usage.execution_id = requested.execution_id
          LEFT JOIN ai_model_call_valuations AS cost
            ON cost.project_id = usage.project_id AND cost.usage_record_id = usage.id
        `
      )
      .all(JSON.stringify([...new Set(input.executionIds)]), input.projectId) as SummaryRow[]
    return aggregateSummaryRows(input.executionIds, rows)
  }

  async queryProjectOverview(input: QueryAiAccountingOverviewInput): Promise<AiAccountingOverview> {
    const query = normalizeAiAccountingQuery(input)
    const rows = this.connection.db
      .query(SQLITE_ACCOUNTING_OVERVIEW_SQL)
      .all(
        query.projectId,
        query.from.toISOString(),
        query.to.toISOString(),
        query.providerId ?? null,
        query.providerId ?? null,
        query.modelId ?? null,
        query.modelId ?? null,
        input.bucket
      ) as AggregateRow[]
    return buildAiAccountingOverviewFromFragments(input, rows.map(aggregateFragmentFromRow))
  }

  async listModelCalls(
    input: ListAiModelCallAccountingInput
  ): Promise<ListAiModelCallAccountingResult> {
    const query = normalizeAiModelCallAccountingQuery(input)
    const parameters = accountingListFilterParameters(query)
    const count = this.connection.db
      .query(SQLITE_ACCOUNTING_LIST_COUNT_SQL)
      .get(...parameters) as CountRow
    const rows = this.connection.db
      .query(SQLITE_ACCOUNTING_LIST_PAGE_SQL)
      .all(...parameters, query.limit, query.offset) as JoinedRow[]
    const items = rows.map((row) => toAccountingItem(accountingItemFromRow(row)))
    const total = safeSqlCount(count.total, "model-call list total")
    return structuredClone({
      items,
      total,
      hasMore: query.offset + items.length < total,
    })
  }

  private insertCost(record: AiModelCallCostRecord): void {
    const valued = record.status !== "unpriceable" ? record : undefined
    const details = aiModelCallCostDetails(record)
    this.connection.db
      .query(
        `INSERT INTO ai_model_call_valuations (
          project_id, usage_record_id, status, provider_id, model_id,
          currency, amount_nanos, reason, details, rated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.projectId,
        record.usageRecordId,
        record.status,
        record.billingIdentity?.providerId ?? null,
        record.billingIdentity?.modelId ?? null,
        valued?.money.currency ?? null,
        valued ? BigInt(valued.money.amountNanos) : null,
        record.status === "unpriceable" ? record.reason : null,
        JSON.stringify(details),
        record.ratedAt.toISOString()
      )
  }

  private findCost(projectId: string, usageId: string): AiModelCallCostRecord | null {
    const row = this.connection.db
      .query(
        `SELECT *, CAST(amount_nanos AS TEXT) AS amount_nanos
         FROM ai_model_call_valuations
         WHERE project_id = ? AND usage_record_id = ?`
      )
      .get(projectId, usageId) as ValuationRow | null
    return row ? rowToCost(row) : null
  }

  private findUsage(projectId: string, id: string): AiModelCallUsageRecord | null {
    const row = this.connection.db
      .query("SELECT * FROM ai_model_call_usage WHERE project_id = ? AND id = ?")
      .get(projectId, id) as UsageRow | null
    return row ? usageFromRow(row, []) : null
  }
}

const SQLITE_ACCOUNTING_LIST_FILTER = `
  usage.project_id = ? AND usage.occurred_at >= ? AND usage.occurred_at < ?
  AND (? IS NULL OR usage.provider_id = ?)
  AND (? IS NULL OR usage.requested_model_id = ?)
  AND (? IS NULL OR usage.execution_id = ?)
  AND (
    ? IS NULL OR ? = COALESCE(cost.status, 'unvalued')
  )
`

const SQLITE_ACCOUNTING_LIST_COUNT_SQL = `
  SELECT CAST(COUNT(*) AS TEXT) AS total
  FROM ai_model_call_usage AS usage
  LEFT JOIN ai_model_call_valuations AS cost
    ON cost.project_id = usage.project_id AND cost.usage_record_id = usage.id
  WHERE ${SQLITE_ACCOUNTING_LIST_FILTER}
`

const SQLITE_ACCOUNTING_LIST_PAGE_SQL = `
  SELECT usage.*,
    CASE
      WHEN direct_agent.kind = 'conversation' THEN 'agent'
      WHEN direct_agent.kind = 'subagent' THEN 'subagent'
      WHEN workflow_agent.node_run_id IS NOT NULL THEN 'workflowAgent'
      ELSE NULL
    END AS attribution_kind,
    workflow_node.node_id AS attribution_agent_step_id,
    direct_agent.id AS attribution_agent_run_id,
    direct_agent.thread_id AS attribution_thread_id,
    direct_agent.parent_run_id AS attribution_parent_run_id,
    workflow_agent.node_run_id AS attribution_node_run_id,
    workflow_node.workflow_id AS attribution_workflow_id,
    workflow_node.workflow_run_id AS attribution_workflow_run_id,
    COALESCE((
      SELECT json_group_array(group_id) FROM (
        SELECT group_id FROM ai_model_call_usage_groups
        WHERE project_id = usage.project_id AND usage_record_id = usage.id
        ORDER BY group_id
      )
    ), '[]') AS requester_group_ids,
    cost.status AS cost_status,
    cost.provider_id AS cost_provider_id,
    cost.model_id AS cost_model_id,
    cost.currency AS cost_currency,
    CAST(cost.amount_nanos AS TEXT) AS cost_amount_nanos,
    cost.reason AS cost_reason,
    cost.details AS cost_details,
    cost.rated_at AS cost_rated_at
  FROM ai_model_call_usage AS usage
  LEFT JOIN agent_runs AS direct_agent
    ON direct_agent.project_id = usage.project_id
    AND direct_agent.execution_id = usage.execution_id
  LEFT JOIN workflow_agent_node_runs AS workflow_agent
    ON workflow_agent.project_id = usage.project_id
    AND workflow_agent.execution_id = usage.execution_id
  LEFT JOIN workflow_node_runs AS workflow_node
    ON workflow_node.project_id = workflow_agent.project_id
    AND workflow_node.id = workflow_agent.node_run_id
  LEFT JOIN ai_model_call_valuations AS cost
    ON cost.project_id = usage.project_id AND cost.usage_record_id = usage.id
  WHERE ${SQLITE_ACCOUNTING_LIST_FILTER}
  ORDER BY usage.occurred_at DESC, usage.id ASC
  LIMIT ? OFFSET ?
`

const SQLITE_ACCOUNTING_OVERVIEW_SQL = `
  WITH classified AS (
    SELECT usage.provider_id,
      usage.requested_model_id,
      usage.occurred_at,
      usage.input_tokens,
      usage.output_tokens,
      usage.uncached_input_tokens,
      usage.cache_read_input_tokens,
      usage.cache_write_input_tokens,
      usage.text_output_tokens,
      usage.reasoning_output_tokens,
      usage.reporting_status,
      CASE
        WHEN direct_agent.kind = 'conversation' THEN 'agent'
        WHEN workflow_agent.node_run_id IS NOT NULL THEN 'workflowAgent'
        ELSE NULL
      END AS attribution_agent_kind,
      workflow_node.node_id AS attribution_agent_step_id,
      workflow_node.workflow_id AS attribution_workflow_id,
      COALESCE(cost.status, 'unvalued') AS valuation_status,
      cost.currency AS amount_currency,
      cost.amount_nanos AS amount_nanos
    FROM ai_model_call_usage AS usage
    LEFT JOIN agent_runs AS direct_agent
      ON direct_agent.project_id = usage.project_id
      AND direct_agent.execution_id = usage.execution_id
    LEFT JOIN workflow_agent_node_runs AS workflow_agent
      ON workflow_agent.project_id = usage.project_id
      AND workflow_agent.execution_id = usage.execution_id
    LEFT JOIN workflow_node_runs AS workflow_node
      ON workflow_node.project_id = workflow_agent.project_id
      AND workflow_node.id = workflow_agent.node_run_id
    LEFT JOIN ai_model_call_valuations AS cost
      ON cost.project_id = usage.project_id AND cost.usage_record_id = usage.id
    WHERE usage.project_id = ? AND usage.occurred_at >= ? AND usage.occurred_at < ?
      AND (? IS NULL OR usage.provider_id = ?)
      AND (? IS NULL OR usage.requested_model_id = ?)
  ), expanded AS (
    SELECT 'totals' AS dimension, NULL AS key_1, NULL AS key_2, NULL AS key_3, NULL AS bucket_start,
      classified.*
    FROM classified
    UNION ALL
    SELECT 'series', NULL, NULL, NULL,
      CASE ?
        WHEN 'hour' THEN strftime('%Y-%m-%dT%H:00:00.000Z', occurred_at)
        WHEN 'day' THEN strftime('%Y-%m-%dT00:00:00.000Z', occurred_at)
        ELSE strftime(
          '%Y-%m-%dT00:00:00.000Z',
          occurred_at,
          printf('-%d days', (CAST(strftime('%w', occurred_at) AS INTEGER) + 6) % 7)
        )
      END,
      classified.*
    FROM classified
    UNION ALL
    SELECT 'model', provider_id, requested_model_id, NULL, NULL, classified.* FROM classified
    UNION ALL
    SELECT 'agent', attribution_agent_kind, attribution_workflow_id, attribution_agent_step_id, NULL, classified.*
    FROM classified WHERE attribution_agent_kind IS NOT NULL
    UNION ALL
    SELECT 'workflow', attribution_workflow_id, NULL, NULL, NULL, classified.*
    FROM classified WHERE attribution_workflow_id IS NOT NULL
  )
  SELECT dimension,
    key_1,
    key_2,
    key_3,
    bucket_start,
    amount_currency,
    CAST(COUNT(*) AS TEXT) AS model_call_count,
    CAST(SUM(CASE WHEN reporting_status <> 'unavailable' THEN 1 ELSE 0 END) AS TEXT)
      AS reported_usage_call_count,
    CAST(COUNT(input_tokens) AS TEXT) AS input_tokens_count,
    CAST(SUM(input_tokens) AS TEXT) AS input_tokens_sum,
    CAST(COUNT(output_tokens) AS TEXT) AS output_tokens_count,
    CAST(SUM(output_tokens) AS TEXT) AS output_tokens_sum,
    CAST(COUNT(uncached_input_tokens) AS TEXT) AS uncached_input_tokens_count,
    CAST(SUM(uncached_input_tokens) AS TEXT) AS uncached_input_tokens_sum,
    CAST(COUNT(cache_read_input_tokens) AS TEXT) AS cache_read_input_tokens_count,
    CAST(SUM(cache_read_input_tokens) AS TEXT) AS cache_read_input_tokens_sum,
    CAST(COUNT(cache_write_input_tokens) AS TEXT) AS cache_write_input_tokens_count,
    CAST(SUM(cache_write_input_tokens) AS TEXT) AS cache_write_input_tokens_sum,
    CAST(COUNT(text_output_tokens) AS TEXT) AS text_output_tokens_count,
    CAST(SUM(text_output_tokens) AS TEXT) AS text_output_tokens_sum,
    CAST(COUNT(reasoning_output_tokens) AS TEXT) AS reasoning_output_tokens_count,
    CAST(SUM(reasoning_output_tokens) AS TEXT) AS reasoning_output_tokens_sum,
    CAST(SUM(CASE WHEN valuation_status = 'rated' THEN 1 ELSE 0 END) AS TEXT)
      AS rated_call_count,
    CAST(SUM(CASE WHEN valuation_status = 'reported' THEN 1 ELSE 0 END) AS TEXT)
      AS reported_cost_call_count,
    CAST(SUM(CASE WHEN valuation_status = 'unpriceable' THEN 1 ELSE 0 END) AS TEXT)
      AS unpriceable_call_count,
    CAST(SUM(CASE WHEN valuation_status = 'unvalued' THEN 1 ELSE 0 END) AS TEXT)
      AS unvalued_call_count,
    CAST(SUM(amount_nanos / 1000000000000) AS TEXT) AS amount_high,
    CAST(SUM((amount_nanos / 1000000) % 1000000) AS TEXT) AS amount_middle,
    CAST(SUM(amount_nanos % 1000000) AS TEXT) AS amount_low
  FROM expanded
  GROUP BY dimension, key_1, key_2, key_3, bucket_start, amount_currency
`

function accountingListFilterParameters(
  query: ReturnType<typeof normalizeAiModelCallAccountingQuery>
): readonly (string | null)[] {
  return [
    query.projectId,
    query.from.toISOString(),
    query.to.toISOString(),
    query.providerId ?? null,
    query.providerId ?? null,
    query.modelId ?? null,
    query.modelId ?? null,
    query.executionId ?? null,
    query.executionId ?? null,
    query.valuationStatus ?? null,
    query.valuationStatus ?? null,
  ]
}

interface ValuationRow {
  readonly project_id: string
  readonly usage_record_id: string
  readonly status: AiModelCallCostRecord["status"]
  readonly provider_id: string | null
  readonly model_id: string | null
  readonly currency: string | null
  readonly amount_nanos: string | null
  readonly reason: string | null
  readonly details: string
  readonly rated_at: string
}

interface UsageRow {
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
  readonly occurred_at: string
  readonly recorded_at: string
}

interface JoinedRow extends UsageRow {
  readonly attribution_kind: "agent" | "subagent" | "workflowAgent" | null
  readonly attribution_agent_step_id: string | null
  readonly attribution_agent_run_id: string | null
  readonly attribution_thread_id: string | null
  readonly attribution_parent_run_id: string | null
  readonly attribution_node_run_id: string | null
  readonly attribution_workflow_id: string | null
  readonly attribution_workflow_run_id: string | null
  readonly requester_group_ids: string
  readonly cost_status: ValuationRow["status"] | null
  readonly cost_provider_id: string | null
  readonly cost_model_id: string | null
  readonly cost_currency: string | null
  readonly cost_amount_nanos: string | null
  readonly cost_reason: string | null
  readonly cost_details: string | null
  readonly cost_rated_at: string | null
}

interface AggregateRow {
  readonly dimension: AiAccountingAggregateFragment["dimension"]
  readonly key_1: string | null
  readonly key_2: string | null
  readonly key_3: string | null
  readonly bucket_start: string | null
  readonly amount_currency: string | null
  readonly model_call_count: string
  readonly reported_usage_call_count: string
  readonly input_tokens_count: string
  readonly input_tokens_sum: string | null
  readonly output_tokens_count: string
  readonly output_tokens_sum: string | null
  readonly uncached_input_tokens_count: string
  readonly uncached_input_tokens_sum: string | null
  readonly cache_read_input_tokens_count: string
  readonly cache_read_input_tokens_sum: string | null
  readonly cache_write_input_tokens_count: string
  readonly cache_write_input_tokens_sum: string | null
  readonly text_output_tokens_count: string
  readonly text_output_tokens_sum: string | null
  readonly reasoning_output_tokens_count: string
  readonly reasoning_output_tokens_sum: string | null
  readonly rated_call_count: string
  readonly reported_cost_call_count: string
  readonly unpriceable_call_count: string
  readonly unvalued_call_count: string
  readonly amount_high: string | null
  readonly amount_middle: string | null
  readonly amount_low: string | null
}

interface CountRow {
  readonly total: string
}

interface SummaryRow {
  readonly execution_id: string
  readonly status: ValuationRow["status"] | null
  readonly currency: string | null
  readonly amount_nanos: string | null
}

function aggregateFragmentFromRow(row: AggregateRow): AiAccountingAggregateFragment {
  const dimensionKeys =
    row.dimension === "model"
      ? { providerId: required(row.key_1), modelId: required(row.key_2) }
      : row.dimension === "agent"
        ? {
            agentKind: required(row.key_1) as "agent" | "workflowAgent",
            ...(row.key_1 === "workflowAgent"
              ? { workflowId: required(row.key_2), agentStepId: required(row.key_3) }
              : {}),
          }
        : row.dimension === "workflow"
          ? { workflowId: required(row.key_1) }
          : row.dimension === "series"
            ? { start: new Date(required(row.bucket_start)) }
            : {}
  return {
    dimension: row.dimension,
    ...dimensionKeys,
    modelCallCount: row.model_call_count,
    usage: {
      reportedCallCount: row.reported_usage_call_count,
      inputTokens: meterFragment(row.input_tokens_count, row.input_tokens_sum),
      outputTokens: meterFragment(row.output_tokens_count, row.output_tokens_sum),
      uncachedInputTokens: meterFragment(
        row.uncached_input_tokens_count,
        row.uncached_input_tokens_sum
      ),
      cacheReadInputTokens: meterFragment(
        row.cache_read_input_tokens_count,
        row.cache_read_input_tokens_sum
      ),
      cacheWriteInputTokens: meterFragment(
        row.cache_write_input_tokens_count,
        row.cache_write_input_tokens_sum
      ),
      textOutputTokens: meterFragment(row.text_output_tokens_count, row.text_output_tokens_sum),
      reasoningOutputTokens: meterFragment(
        row.reasoning_output_tokens_count,
        row.reasoning_output_tokens_sum
      ),
    },
    costs: {
      ...(row.amount_currency === null ||
      row.amount_high === null ||
      row.amount_middle === null ||
      row.amount_low === null
        ? {}
        : {
            amount: {
              currency: row.amount_currency,
              amountNanos: sqliteAggregateAmount(row),
            },
          }),
      ratedCallCount: row.rated_call_count,
      reportedCallCount: row.reported_cost_call_count,
      unpriceableCallCount: row.unpriceable_call_count,
      unvaluedCallCount: row.unvalued_call_count,
    },
  }
}

function meterFragment(presentCallCount: string, total: string | null) {
  return { presentCallCount, total }
}

function sqliteAggregateAmount(
  row: Pick<AggregateRow, "amount_high" | "amount_middle" | "amount_low">
): string {
  return (
    BigInt(required(row.amount_high)) * 1_000_000_000_000n +
    BigInt(required(row.amount_middle)) * 1_000_000n +
    BigInt(required(row.amount_low))
  ).toString()
}

function accountingItemFromRow(row: JoinedRow): AiAccountingRecordSetItem {
  const usage = usageFromRow(row, parseStringArray(row.requester_group_ids))
  const cost = row.cost_status === null ? undefined : costFromJoinedRow(row)
  const attribution =
    row.attribution_kind === null
      ? undefined
      : row.attribution_kind === "agent"
        ? {
            kind: "agent" as const,
            agentRunId: required(row.attribution_agent_run_id),
            threadId: required(row.attribution_thread_id),
          }
        : row.attribution_kind === "subagent"
          ? {
              kind: "subagent" as const,
              subagentRunId: required(row.attribution_agent_run_id),
              parentRunId: required(row.attribution_parent_run_id),
            }
          : {
              kind: "workflowAgent" as const,
              agentStepId: required(row.attribution_agent_step_id),
              nodeRunId: required(row.attribution_node_run_id),
              workflowId: required(row.attribution_workflow_id),
              workflowRunId: required(row.attribution_workflow_run_id),
            }
  return {
    usage,
    ...(attribution ? { attribution } : {}),
    ...(cost ? { cost } : {}),
  }
}

function usageFromRow(row: UsageRow, requesterGroupIds: readonly string[]): AiModelCallUsageRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    executionId: row.execution_id,
    attempt: row.attempt,
    callId: row.call_id,
    requesterGroupIds,
    providerId: row.provider_id,
    requestedModelId: row.requested_model_id,
    ...(row.response_model_id === null ? {} : { responseModelId: row.response_model_id }),
    responseId: row.response_id,
    usage: {
      ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
      ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
      ...(row.total_tokens === null ? {} : { totalTokens: row.total_tokens }),
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
      reportingStatus: row.reporting_status,
    },
    ...(row.raw_usage === null
      ? {}
      : { rawUsage: JSON.parse(row.raw_usage) as ReadonlyJsonObject }),
    occurredAt: new Date(row.occurred_at),
    recordedAt: new Date(row.recorded_at),
  }
}

function rowToCost(row: ValuationRow): AiModelCallCostRecord {
  return costRecord({
    projectId: row.project_id,
    usageId: row.usage_record_id,
    status: row.status,
    providerId: row.provider_id,
    modelId: row.model_id,
    currency: row.currency,
    amountNanos: row.amount_nanos,
    reason: row.reason,
    details: row.details,
    ratedAt: row.rated_at,
  })
}

function costFromJoinedRow(row: JoinedRow): AiModelCallCostRecord {
  return costRecord({
    projectId: row.project_id,
    usageId: row.id,
    status: required(row.cost_status),
    providerId: row.cost_provider_id,
    modelId: row.cost_model_id,
    currency: row.cost_currency,
    amountNanos: row.cost_amount_nanos,
    reason: row.cost_reason,
    details: required(row.cost_details),
    ratedAt: required(row.cost_rated_at),
  })
}

function costRecord(input: {
  projectId: string
  usageId: string
  status: ValuationRow["status"]
  providerId: string | null
  modelId: string | null
  currency: string | null
  amountNanos: string | null
  reason: string | null
  details: string
  ratedAt: string
}): AiModelCallCostRecord {
  const details = parseAiModelCallCostDetails(input.details)
  const base = {
    projectId: input.projectId,
    usageRecordId: input.usageId,
    pricingContext: details.pricingContext,
    ratedAt: new Date(input.ratedAt),
  }
  if (input.status === "reported") {
    return normalizeAiModelCallCostRecord({
      ...base,
      status: "reported",
      billingIdentity: { providerId: required(input.providerId), modelId: required(input.modelId) },
      money: { currency: required(input.currency), amountNanos: required(input.amountNanos) },
      reportSource: required(details.reportSource),
    })
  }
  const source = required(details.priceSource)
  const priceSource = { ...source, observedAt: new Date(source.observedAt) }
  if (input.status === "rated") {
    return normalizeAiModelCallCostRecord({
      ...base,
      priceSource,
      status: "rated",
      billingIdentity: { providerId: required(input.providerId), modelId: required(input.modelId) },
      money: { currency: required(input.currency), amountNanos: required(input.amountNanos) },
      components: required(details.components),
    })
  }
  return normalizeAiModelCallCostRecord({
    ...base,
    priceSource,
    status: "unpriceable",
    ...(input.providerId && input.modelId
      ? { billingIdentity: { providerId: input.providerId, modelId: input.modelId } }
      : {}),
    reason: required(input.reason) as Extract<
      AiModelCallCostRecord,
      { status: "unpriceable" }
    >["reason"],
    ...(details.missingMeters ? { missingMeters: details.missingMeters } : {}),
  })
}

function aggregateSummaryRows(
  ids: readonly string[],
  rows: readonly SummaryRow[]
): AiCostSummary[] {
  const map = new Map(ids.map((id) => [id, accumulator()]))
  for (const row of rows) {
    const value = map.get(row.execution_id)
    if (!value) continue
    if (row.status === null) value.unvaluedCallCount += 1
    else if (row.status === "unpriceable") value.unpriceableCallCount += 1
    else {
      if (row.status === "reported") value.reportedCallCount += 1
      else value.ratedCallCount += 1
      add(value.amounts, required(row.currency), required(row.amount_nanos))
    }
  }
  return ids.map((id) => finish(map.get(id)!))
}

interface Accumulator {
  amounts: Map<string, bigint>
  reportedCallCount: number
  ratedCallCount: number
  unpriceableCallCount: number
  unvaluedCallCount: number
}

function accumulator(): Accumulator {
  return {
    amounts: new Map(),
    reportedCallCount: 0,
    ratedCallCount: 0,
    unpriceableCallCount: 0,
    unvaluedCallCount: 0,
  }
}

function finish(value: Accumulator): AiCostSummary {
  return {
    amounts: [...value.amounts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, amount]) => ({ currency, amountNanos: amount.toString() })),
    reportedCallCount: value.reportedCallCount,
    ratedCallCount: value.ratedCallCount,
    unpriceableCallCount: value.unpriceableCallCount,
    unvaluedCallCount: value.unvaluedCallCount,
  }
}

function add(amounts: Map<string, bigint>, currency: string, amount: string): void {
  amounts.set(currency, (amounts.get(currency) ?? 0n) + BigInt(amount))
}

function assertCostMatchesUsage(
  record: AiModelCallCostRecord,
  usage: AiModelCallUsageRecord
): void {
  if (!aiModelCallCostMatchesUsage(record, usage)) {
    throw new AiCostStorageError(
      "cost_mismatch",
      `[SixbSqlite] AI valuation for usage '${record.usageRecordId}' does not match its usage record.`
    )
  }
}

function missingUsage(record: { projectId: string; usageRecordId: string }) {
  return new AiCostStorageError(
    "missing_usage",
    `[SixbSqlite] AI usage '${record.usageRecordId}' does not exist.`
  )
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("[SixbSqlite] AI requester group ids are invalid.")
  }
  return parsed
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`[Sixb] AI ${field} must be nonblank.`)
  }
}

function safeSqlCount(value: string, field: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`[SixbSqlite] AI accounting ${field} is invalid.`)
  }
  const count = Number(value)
  if (!Number.isSafeInteger(count)) {
    throw new TypeError(`[Sixb] AI accounting ${field} exceeds the safe integer range.`)
  }
  return count
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("[SixbSqlite] AI valuation column is unexpectedly null.")
  }
  return value
}
