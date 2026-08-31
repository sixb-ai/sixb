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
  type QueryAiAccountingOverviewInput,
  type SummarizeAiCostExecutionsInput,
} from "@sixb/core/storage"
import type { PgStoreClient } from "./transactions"
import { runPgTransaction } from "./transactions"

/** PostgreSQL-backed immutable valuations stored in one append-only table. */
export class PgAiCostStorage implements AiCostStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async recordModelCallCost(input: AiModelCallCostRecord): Promise<void> {
    const record = normalizeAiModelCallCostRecord(input)
    await runPgTransaction(this.sql, async (tx) => {
      const usage = await findUsage(tx, record.projectId, record.usageRecordId)
      if (!usage) throw missingUsage(record)
      assertCostMatchesUsage(record, usage)
      if (await findCost(tx, record.projectId, record.usageRecordId)) return
      const rated = record.status === "rated" ? record : undefined
      const inserted = await tx<{ usage_record_id: string }[]>`
        INSERT INTO ai_model_call_valuations (
          project_id, usage_record_id, status, provider_id, model_id,
          currency, amount_nanos, reason, details, rated_at
        ) VALUES (
          ${record.projectId}, ${record.usageRecordId}, ${record.status},
          ${record.billingIdentity?.providerId ?? null},
          ${record.billingIdentity?.modelId ?? null}, ${rated?.money.currency ?? null},
          ${rated?.money.amountNanos ?? null},
          ${record.status === "unpriceable" ? record.reason : null},
          ${JSON.stringify(aiModelCallCostDetails(record))}::text::jsonb, ${record.ratedAt}
        )
        ON CONFLICT DO NOTHING
        RETURNING usage_record_id
      `
      if (inserted.length === 0 && !(await findCost(tx, record.projectId, record.usageRecordId))) {
        throw new Error("[SixbPg] AI valuation insert conflicted without a visible row.")
      }
    })
  }

  async summarizeExecutions(
    input: SummarizeAiCostExecutionsInput
  ): Promise<readonly AiCostSummary[]> {
    assertNonBlank(input.projectId, "cost summary projectId")
    for (const id of input.executionIds) assertNonBlank(id, "cost summary executionId")
    if (input.executionIds.length === 0) return []
    const ids = [...new Set(input.executionIds)]
    const rows = await this.sql<SummaryRow[]>`
      WITH requested(execution_id) AS (
        SELECT DISTINCT * FROM unnest(${this.sql.array(ids)}::text[])
      )
      SELECT usage.execution_id,
        cost.status,
        cost.currency,
        cost.amount_nanos
      FROM requested
      JOIN ai_model_call_usage AS usage
        ON usage.project_id = ${input.projectId} AND usage.execution_id = requested.execution_id
      LEFT JOIN ai_model_call_valuations AS cost
        ON cost.project_id = usage.project_id AND cost.usage_record_id = usage.id
    `
    return aggregateSummaryRows(input.executionIds, rows)
  }

  async queryProjectOverview(input: QueryAiAccountingOverviewInput): Promise<AiAccountingOverview> {
    const query = normalizeAiAccountingQuery(input)
    const providerId = query.providerId ?? null
    const modelId = query.modelId ?? null
    const rows = await this.sql<AggregateRow[]>`
      WITH filtered AS (
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
          COALESCE(direct_agent.agent_id, workflow_agent.agent_id) AS attribution_agent_id,
          workflow_node.workflow_id AS attribution_workflow_id,
          cost.status AS cost_status,
          cost.currency AS cost_currency,
          cost.amount_nanos AS cost_amount_nanos
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
        WHERE usage.project_id = ${query.projectId}
          AND usage.occurred_at >= ${query.from} AND usage.occurred_at < ${query.to}
          AND (${providerId}::text IS NULL OR usage.provider_id = ${providerId})
          AND (${modelId}::text IS NULL OR usage.requested_model_id = ${modelId})
      ), classified AS (
        SELECT filtered.*,
          CASE
            WHEN cost_status = 'rated' THEN 'rated'
            WHEN cost_status = 'unpriceable' THEN 'unpriceable'
            ELSE 'unvalued'
          END AS valuation_status,
          CASE WHEN cost_status = 'rated' THEN cost_currency ELSE NULL END AS amount_currency,
          CASE WHEN cost_status = 'rated' THEN cost_amount_nanos ELSE NULL END AS amount_nanos
        FROM filtered
      ), expanded AS (
        SELECT 'totals'::text AS dimension,
          NULL::text AS key_1,
          NULL::text AS key_2,
          NULL::timestamptz AS bucket_start,
          classified.*
        FROM classified
        UNION ALL
        SELECT 'series', NULL, NULL,
          CASE ${input.bucket}::text
            WHEN 'hour' THEN
              date_trunc('hour', occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            WHEN 'day' THEN
              date_trunc('day', occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            ELSE date_trunc('week', occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          END,
          classified.*
        FROM classified
        UNION ALL
        SELECT 'model', provider_id, requested_model_id, NULL, classified.* FROM classified
        UNION ALL
        SELECT 'agent', attribution_agent_id, NULL, NULL, classified.*
        FROM classified WHERE attribution_agent_id IS NOT NULL
        UNION ALL
        SELECT 'workflow', attribution_workflow_id, NULL, NULL, classified.*
        FROM classified WHERE attribution_workflow_id IS NOT NULL
      )
      SELECT dimension,
        key_1,
        key_2,
        bucket_start,
        amount_currency,
        COUNT(*)::text AS model_call_count,
        COUNT(*) FILTER (WHERE reporting_status <> 'unavailable')::text
          AS reported_usage_call_count,
        COUNT(input_tokens)::text AS input_tokens_count,
        SUM(input_tokens)::text AS input_tokens_sum,
        COUNT(output_tokens)::text AS output_tokens_count,
        SUM(output_tokens)::text AS output_tokens_sum,
        COUNT(uncached_input_tokens)::text AS uncached_input_tokens_count,
        SUM(uncached_input_tokens)::text AS uncached_input_tokens_sum,
        COUNT(cache_read_input_tokens)::text AS cache_read_input_tokens_count,
        SUM(cache_read_input_tokens)::text AS cache_read_input_tokens_sum,
        COUNT(cache_write_input_tokens)::text AS cache_write_input_tokens_count,
        SUM(cache_write_input_tokens)::text AS cache_write_input_tokens_sum,
        COUNT(text_output_tokens)::text AS text_output_tokens_count,
        SUM(text_output_tokens)::text AS text_output_tokens_sum,
        COUNT(reasoning_output_tokens)::text AS reasoning_output_tokens_count,
        SUM(reasoning_output_tokens)::text AS reasoning_output_tokens_sum,
        COUNT(*) FILTER (WHERE valuation_status = 'rated')::text AS rated_call_count,
        COUNT(*) FILTER (WHERE valuation_status = 'unpriceable')::text
          AS unpriceable_call_count,
        COUNT(*) FILTER (WHERE valuation_status = 'unvalued')::text
          AS unvalued_call_count,
        SUM(amount_nanos)::text AS amount_nanos
      FROM expanded
      GROUP BY dimension, key_1, key_2, bucket_start, amount_currency
    `
    return buildAiAccountingOverviewFromFragments(input, rows.map(aggregateFragmentFromRow))
  }

  async listModelCalls(
    input: ListAiModelCallAccountingInput
  ): Promise<ListAiModelCallAccountingResult> {
    const query = normalizeAiModelCallAccountingQuery(input)
    const providerId = query.providerId ?? null
    const modelId = query.modelId ?? null
    const executionId = query.executionId ?? null
    const valuationStatus = query.valuationStatus ?? null
    const [count] = await this.sql<CountRow[]>`
      SELECT COUNT(*)::text AS total
      FROM ai_model_call_usage AS usage
      LEFT JOIN ai_model_call_valuations AS cost
        ON cost.project_id = usage.project_id AND cost.usage_record_id = usage.id
      WHERE usage.project_id = ${query.projectId}
        AND usage.occurred_at >= ${query.from} AND usage.occurred_at < ${query.to}
        AND (${providerId}::text IS NULL OR usage.provider_id = ${providerId})
        AND (${modelId}::text IS NULL OR usage.requested_model_id = ${modelId})
        AND (${executionId}::text IS NULL OR usage.execution_id = ${executionId})
        AND (
          ${valuationStatus}::text IS NULL OR ${valuationStatus} = CASE
            WHEN cost.status = 'rated' THEN 'rated'
            WHEN cost.status = 'unpriceable' THEN 'unpriceable'
            ELSE 'unvalued'
          END
        )
    `
    const rows = await this.sql<JoinedRow[]>`
      SELECT usage.*,
        CASE
          WHEN direct_agent.id IS NOT NULL THEN 'agent'
          WHEN workflow_agent.node_run_id IS NOT NULL THEN 'workflowAgent'
          ELSE NULL
        END AS attribution_kind,
        COALESCE(direct_agent.agent_id, workflow_agent.agent_id) AS attribution_agent_id,
        direct_agent.id AS attribution_agent_run_id,
        direct_agent.thread_id AS attribution_thread_id,
        workflow_agent.node_run_id AS attribution_node_run_id,
        workflow_node.workflow_id AS attribution_workflow_id,
        workflow_node.workflow_run_id AS attribution_workflow_run_id,
        COALESCE((
          SELECT jsonb_agg(groups.group_id ORDER BY groups.group_id)
          FROM ai_model_call_usage_groups AS groups
          WHERE groups.project_id = usage.project_id AND groups.usage_record_id = usage.id
        ), '[]'::jsonb) AS requester_group_ids,
        cost.status AS cost_status,
        cost.provider_id AS cost_provider_id,
        cost.model_id AS cost_model_id,
        cost.currency AS cost_currency,
        cost.amount_nanos AS cost_amount_nanos,
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
      WHERE usage.project_id = ${query.projectId}
        AND usage.occurred_at >= ${query.from} AND usage.occurred_at < ${query.to}
        AND (${providerId}::text IS NULL OR usage.provider_id = ${providerId})
        AND (${modelId}::text IS NULL OR usage.requested_model_id = ${modelId})
        AND (${executionId}::text IS NULL OR usage.execution_id = ${executionId})
        AND (
          ${valuationStatus}::text IS NULL OR ${valuationStatus} = CASE
            WHEN cost.status = 'rated' THEN 'rated'
            WHEN cost.status = 'unpriceable' THEN 'unpriceable'
            ELSE 'unvalued'
          END
        )
      ORDER BY usage.occurred_at DESC, usage.id ASC
      LIMIT ${query.limit} OFFSET ${query.offset}
    `
    const items = rows.map((row) => toAccountingItem(accountingItemFromRow(row)))
    if (!count) throw new Error("[SixbPg] AI accounting count query returned no row.")
    const total = safeSqlCount(count.total, "model-call list total")
    return structuredClone({
      items,
      total,
      hasMore: query.offset + items.length < total,
    })
  }
}

interface ValuationRow {
  readonly project_id: string
  readonly usage_record_id: string
  readonly status: "rated" | "unpriceable"
  readonly provider_id: string | null
  readonly model_id: string | null
  readonly currency: string | null
  readonly amount_nanos: string | null
  readonly reason: string | null
  readonly details: unknown
  readonly rated_at: Date | string
}

interface UsageRow {
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

interface JoinedRow extends UsageRow {
  readonly attribution_kind: "agent" | "workflowAgent" | null
  readonly attribution_agent_id: string | null
  readonly attribution_agent_run_id: string | null
  readonly attribution_thread_id: string | null
  readonly attribution_node_run_id: string | null
  readonly attribution_workflow_id: string | null
  readonly attribution_workflow_run_id: string | null
  readonly requester_group_ids: unknown
  readonly cost_status: ValuationRow["status"] | null
  readonly cost_provider_id: string | null
  readonly cost_model_id: string | null
  readonly cost_currency: string | null
  readonly cost_amount_nanos: string | null
  readonly cost_reason: string | null
  readonly cost_details: unknown
  readonly cost_rated_at: Date | string | null
}

interface AggregateRow {
  readonly dimension: AiAccountingAggregateFragment["dimension"]
  readonly key_1: string | null
  readonly key_2: string | null
  readonly bucket_start: Date | string | null
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
  readonly unpriceable_call_count: string
  readonly unvalued_call_count: string
  readonly amount_nanos: string | null
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

async function findCost(
  sql: PgStoreClient,
  projectId: string,
  usageId: string
): Promise<AiModelCallCostRecord | null> {
  const [row] = await sql<ValuationRow[]>`
    SELECT * FROM ai_model_call_valuations
    WHERE project_id = ${projectId} AND usage_record_id = ${usageId}
  `
  return row ? rowToCost(row) : null
}

async function findUsage(
  sql: PgStoreClient,
  projectId: string,
  id: string
): Promise<AiModelCallUsageRecord | null> {
  const [row] = await sql<UsageRow[]>`
    SELECT * FROM ai_model_call_usage WHERE project_id = ${projectId} AND id = ${id}
  `
  return row ? usageFromRow(row, []) : null
}

function aggregateFragmentFromRow(row: AggregateRow): AiAccountingAggregateFragment {
  const dimensionKeys =
    row.dimension === "model"
      ? { providerId: required(row.key_1), modelId: required(row.key_2) }
      : row.dimension === "agent"
        ? { agentId: required(row.key_1) }
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
      ...(row.amount_currency === null || row.amount_nanos === null
        ? {}
        : {
            amount: {
              currency: row.amount_currency,
              amountNanos: row.amount_nanos,
            },
          }),
      ratedCallCount: row.rated_call_count,
      unpriceableCallCount: row.unpriceable_call_count,
      unvaluedCallCount: row.unvalued_call_count,
    },
  }
}

function meterFragment(presentCallCount: string, total: string | null) {
  return { presentCallCount, total }
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
            agentId: required(row.attribution_agent_id),
            agentRunId: required(row.attribution_agent_run_id),
            threadId: required(row.attribution_thread_id),
          }
        : {
            kind: "workflowAgent" as const,
            agentId: required(row.attribution_agent_id),
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
  const number = (value: number | string | null) => (value === null ? undefined : Number(value))
  return {
    id: row.id,
    projectId: row.project_id,
    executionId: row.execution_id,
    attempt: Number(row.attempt),
    callId: row.call_id,
    requesterGroupIds,
    providerId: row.provider_id,
    requestedModelId: row.requested_model_id,
    ...(row.response_model_id === null ? {} : { responseModelId: row.response_model_id }),
    responseId: row.response_id,
    usage: {
      ...(number(row.input_tokens) === undefined ? {} : { inputTokens: number(row.input_tokens) }),
      ...(number(row.output_tokens) === undefined
        ? {}
        : { outputTokens: number(row.output_tokens) }),
      ...(number(row.total_tokens) === undefined ? {} : { totalTokens: number(row.total_tokens) }),
      ...(number(row.uncached_input_tokens) === undefined
        ? {}
        : { uncachedInputTokens: number(row.uncached_input_tokens) }),
      ...(number(row.cache_read_input_tokens) === undefined
        ? {}
        : { cacheReadInputTokens: number(row.cache_read_input_tokens) }),
      ...(number(row.cache_write_input_tokens) === undefined
        ? {}
        : { cacheWriteInputTokens: number(row.cache_write_input_tokens) }),
      ...(number(row.text_output_tokens) === undefined
        ? {}
        : { textOutputTokens: number(row.text_output_tokens) }),
      ...(number(row.reasoning_output_tokens) === undefined
        ? {}
        : { reasoningOutputTokens: number(row.reasoning_output_tokens) }),
      reportingStatus: row.reporting_status,
    },
    ...(row.raw_usage === null ? {} : { rawUsage: parseJsonObject(row.raw_usage) }),
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
    details: row.cost_details,
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
  details: unknown
  ratedAt: Date | string
}): AiModelCallCostRecord {
  const details = parseAiModelCallCostDetails(input.details)
  const priceSource =
    details.priceSource === undefined
      ? undefined
      : { ...details.priceSource, observedAt: new Date(details.priceSource.observedAt) }
  const base = {
    projectId: input.projectId,
    usageRecordId: input.usageId,
    pricingContext: details.pricingContext,
    ratedAt: new Date(input.ratedAt),
  }
  if (input.status === "rated") {
    return normalizeAiModelCallCostRecord({
      ...base,
      status: "rated",
      billingIdentity: { providerId: required(input.providerId), modelId: required(input.modelId) },
      priceSource: required(priceSource),
      money: { currency: required(input.currency), amountNanos: required(input.amountNanos) },
      components: required(details.components),
    })
  }
  return normalizeAiModelCallCostRecord({
    ...base,
    status: "unpriceable",
    ...(input.providerId && input.modelId
      ? { billingIdentity: { providerId: input.providerId, modelId: input.modelId } }
      : {}),
    ...(priceSource === undefined ? {} : { priceSource }),
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
      value.ratedCallCount += 1
      add(value.amounts, required(row.currency), required(row.amount_nanos))
    }
  }
  return ids.map((id) => finish(map.get(id)!))
}

interface Accumulator {
  amounts: Map<string, bigint>
  ratedCallCount: number
  unpriceableCallCount: number
  unvaluedCallCount: number
}

function accumulator(): Accumulator {
  return {
    amounts: new Map(),
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
    ratedCallCount: value.ratedCallCount,
    unpriceableCallCount: value.unpriceableCallCount,
    unvaluedCallCount: value.unvaluedCallCount,
  }
}

function add(amounts: Map<string, bigint>, currency: string, amount: string): void {
  amounts.set(currency, (amounts.get(currency) ?? 0n) + BigInt(amount))
}

function parseStringArray(value: unknown): string[] {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("[SixbPg] AI requester group ids are invalid.")
  }
  return parsed
}

function parseJsonObject(value: unknown): ReadonlyJsonObject {
  return (typeof value === "string" ? JSON.parse(value) : value) as ReadonlyJsonObject
}

function assertCostMatchesUsage(
  record: AiModelCallCostRecord,
  usage: AiModelCallUsageRecord
): void {
  if (!aiModelCallCostMatchesUsage(record, usage)) {
    throw new AiCostStorageError(
      "cost_mismatch",
      `[SixbPg] AI valuation for usage '${record.usageRecordId}' does not match its usage record.`
    )
  }
}

function missingUsage(record: { projectId: string; usageRecordId: string }) {
  return new AiCostStorageError(
    "missing_usage",
    `[SixbPg] AI usage '${record.usageRecordId}' does not exist.`
  )
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`[Sixb] AI ${field} must be nonblank.`)
  }
}

function safeSqlCount(value: string, field: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`[SixbPg] AI accounting ${field} is invalid.`)
  }
  const count = Number(value)
  if (!Number.isSafeInteger(count)) {
    throw new TypeError(`[Sixb] AI accounting ${field} exceeds the safe integer range.`)
  }
  return count
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("[SixbPg] AI valuation column is unexpectedly null.")
  }
  return value
}
