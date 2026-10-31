import {
  type AiModelCallGroupRow,
  aiModelCallGroupFragmentFromRow,
  buildAiModelCallGroupsFromFragments,
  normalizeAiModelCallAccountingQuery,
  normalizeAiModelCallGroupSort,
  TOKENLESS_MODEL_KINDS,
} from "@sixb/core/internal/ai-cost-storage-provider"
import type { ListAiModelCallGroupsInput, ListAiModelCallGroupsResult } from "@sixb/core/storage"
import {
  SQLITE_SOURCE_KIND,
  SQLITE_SOURCE_WORKFLOW,
  sqliteAccountingFilter,
  sqliteAccountingFilterParameters,
} from "./ai-accounting-filters"
import type { SqliteStoreConnection } from "./transactions"

/** Positional `?` placeholders numbered from `start`, to sit among this file's numbered ones. */
function numbered(sql: string, start: number): string {
  let next = start
  return sql.replace(/\?(?!\d)/g, () => `?${next++}`)
}

/** Paginate conversations, workflow runs and other initiating executions, then aggregate their matching calls without loading usage payloads. */
export async function listAiModelCallGroups(
  connection: SqliteStoreConnection,
  input: ListAiModelCallGroupsInput
): Promise<ListAiModelCallGroupsResult> {
  const query = normalizeAiModelCallAccountingQuery(input)
  const sort = normalizeAiModelCallGroupSort(input.sort)
  const parameters = [
    query.projectId,
    query.from.toISOString(),
    query.to.toISOString(),
    query.providerId ?? null,
    query.modelId ?? null,
    query.valuationStatus ?? null,
  ]
  const filters = sqliteAccountingFilterParameters(query)
  const count = connection.db.query(COUNT_SQL).get(...parameters, ...filters) as { total: string }
  const rows = connection.db
    .query(PAGE_SQL)
    .all(...parameters, ...filters, query.limit, query.offset, sort) as AiModelCallGroupRow[]
  const total = Number(count?.total)
  if (!Number.isSafeInteger(total) || total < 0)
    throw new RangeError("[Sixb] Invalid model-call group count.")
  const items = buildAiModelCallGroupsFromFragments(rows.map(aiModelCallGroupFragmentFromRow), sort)
  return { items, total, hasMore: query.offset + items.length < total }
}

// Fixed kind names, never user input.
const TOKENLESS_KINDS = TOKENLESS_MODEL_KINDS.map((kind) => `'${kind}'`).join(", ")

const FILTERED_SQL = `
WITH filtered AS (
  SELECT COALESCE(root_agent.execution_id, usage.execution_id) AS root_execution_id,
    -- What the call is listed under, as aiModelCallGroupKey computes it.
    CASE
      WHEN root_agent.thread_id IS NOT NULL THEN 'thread:' || root_agent.thread_id
      WHEN workflow_node.workflow_run_id IS NOT NULL THEN 'workflowRun:' || workflow_node.workflow_run_id
      ELSE COALESCE(root_agent.execution_id, usage.execution_id)
    END AS group_key,
    usage.execution_id, usage.provider_id, usage.requested_model_id, usage.occurred_at,
    usage.total_tokens, usage.input_tokens, usage.cache_read_input_tokens,
    usage.model_kind, usage.output_images, usage.input_characters,
    usage.audio_duration_ms,
    execution.executor_kind, execution.executor_id, execution.authority_primitive_id AS primitive_id,
    COALESCE(cost.status, 'unvalued') AS valuation_status,
    cost.currency AS amount_currency, cost.amount_nanos,
    root_agent.id AS root_agent_run_id,
    root_agent.thread_id AS root_thread_id,
    direct_agent.kind AS direct_kind,
    direct_agent.id AS direct_run_id,
    direct_agent.parent_run_id AS parent_run_id,
    workflow_node.node_id AS workflow_agent_step_id,
    workflow_agent.node_run_id AS workflow_node_run_id,
    workflow_node.workflow_id AS workflow_id,
    workflow_node.workflow_run_id AS workflow_run_id,
    execution.requested_by_user_id, execution.requested_by_service_account_id
  FROM ai_model_call_usage AS usage
  JOIN executions AS execution ON execution.project_id = usage.project_id AND execution.id = usage.execution_id
  LEFT JOIN agent_runs AS direct_agent
    ON direct_agent.project_id = usage.project_id AND direct_agent.execution_id = usage.execution_id
  LEFT JOIN agent_runs AS root_agent
    ON root_agent.project_id = usage.project_id
    AND root_agent.id = COALESCE(direct_agent.parent_run_id, direct_agent.id)
  LEFT JOIN workflow_agent_node_runs AS workflow_agent
    ON workflow_agent.project_id = usage.project_id AND workflow_agent.execution_id = usage.execution_id
  LEFT JOIN workflow_node_runs AS workflow_node
    ON workflow_node.project_id = workflow_agent.project_id AND workflow_node.id = workflow_agent.node_run_id
  LEFT JOIN ai_model_call_valuations AS cost
    ON cost.project_id = usage.project_id AND cost.usage_record_id = usage.id
  WHERE usage.project_id = ?1
    AND usage.occurred_at >= ?2
    AND usage.occurred_at < ?3
    AND (?4 IS NULL OR usage.provider_id = ?4)
    AND (?5 IS NULL OR usage.requested_model_id = ?5)
    AND (?6 IS NULL OR COALESCE(cost.status, 'unvalued') = ?6)
    AND ${numbered(
      sqliteAccountingFilter({
        kind: "usage.model_kind",
        sourceKind: SQLITE_SOURCE_KIND,
        sourceWorkflow: SQLITE_SOURCE_WORKFLOW,
        userId: "execution.requested_by_user_id",
        serviceAccountId: "execution.requested_by_service_account_id",
      }),
      7
    )}
), roots AS (
  SELECT group_key, MAX(occurred_at) AS last_call_at, TOTAL(amount_nanos) AS cost_nanos
  FROM filtered GROUP BY group_key
)
`
const COUNT_SQL = `${FILTERED_SQL} SELECT CAST(COUNT(*) AS TEXT) AS total FROM roots`
const PAGE_SQL = `${FILTERED_SQL}, page AS (
  SELECT group_key FROM roots
  ORDER BY CASE WHEN ?21 = 'cost' THEN cost_nanos END DESC, last_call_at DESC, group_key ASC
  LIMIT ?19 OFFSET ?20
)
SELECT filtered.group_key, root_execution_id, execution_id, provider_id, requested_model_id,
  MIN(occurred_at) AS first_call_at, MAX(occurred_at) AS last_call_at,
  CAST(COUNT(*) AS TEXT) AS call_count,
  CAST(COUNT(total_tokens) AS TEXT) AS token_count,
  CAST(COUNT(CASE WHEN total_tokens IS NULL AND model_kind IN (${TOKENLESS_KINDS}) THEN 1 END) AS TEXT)
    AS tokenless_count,
  CAST(SUM(total_tokens) AS TEXT) AS total_tokens,
  CAST(SUM(input_tokens) AS TEXT) AS input_tokens,
  CAST(SUM(cache_read_input_tokens) AS TEXT) AS cache_read_input_tokens,
  CAST(SUM(output_images) AS TEXT) AS output_images,
  CAST(SUM(input_characters) AS TEXT) AS input_characters,
  CAST(SUM(audio_duration_ms) AS TEXT) AS audio_duration_ms,
  valuation_status, amount_currency,
  CAST(SUM(amount_nanos / 1000000000000) AS TEXT) AS amount_high,
  CAST(SUM((amount_nanos / 1000000) % 1000000) AS TEXT) AS amount_middle,
  CAST(SUM(amount_nanos % 1000000) AS TEXT) AS amount_low,
  MAX(root_agent_run_id) AS root_agent_run_id,
  MAX(executor_kind) AS executor_kind, MAX(executor_id) AS executor_id, MAX(primitive_id) AS primitive_id,
  MAX(root_thread_id) AS root_thread_id,
  MAX(direct_kind) AS direct_kind,
  MAX(direct_run_id) AS direct_run_id,
  MAX(parent_run_id) AS parent_run_id,
  MAX(workflow_agent_step_id) AS workflow_agent_step_id,
  MAX(workflow_node_run_id) AS workflow_node_run_id,
  MAX(workflow_id) AS workflow_id,
  MAX(workflow_run_id) AS workflow_run_id,
  MAX(requested_by_user_id) AS requested_by_user_id,
  MAX(requested_by_service_account_id) AS requested_by_service_account_id
FROM filtered JOIN page ON page.group_key = filtered.group_key
GROUP BY filtered.group_key, root_execution_id, execution_id, provider_id, requested_model_id,
  valuation_status, amount_currency
`
