import {
  type AiModelCallGroupRow,
  aiModelCallGroupFragmentFromRow,
  buildAiModelCallGroupsFromFragments,
  normalizeAiModelCallAccountingQuery,
} from "@sixb/core/internal/ai-cost-storage-provider"
import type { ListAiModelCallGroupsInput, ListAiModelCallGroupsResult } from "@sixb/core/storage"
import type { PgStoreClient } from "./transactions"

/** Paginate initiating executions, then aggregate their matching calls without loading usage payloads. */
export async function listAiModelCallGroups(
  sql: PgStoreClient,
  input: ListAiModelCallGroupsInput
): Promise<ListAiModelCallGroupsResult> {
  const query = normalizeAiModelCallAccountingQuery(input)
  const parameters = [
    query.projectId,
    query.from.toISOString(),
    query.to.toISOString(),
    query.providerId ?? null,
    query.modelId ?? null,
    query.valuationStatus ?? null,
  ]
  const [count] = await sql.unsafe<{ total: string }[]>(COUNT_SQL, parameters)
  const rows = await sql.unsafe<AiModelCallGroupRow[]>(PAGE_SQL, [
    ...parameters,
    query.limit,
    query.offset,
  ])
  const total = Number(count?.total)
  if (!Number.isSafeInteger(total) || total < 0)
    throw new RangeError("[Sixb] Invalid model-call group count.")
  const items = buildAiModelCallGroupsFromFragments(rows.map(aiModelCallGroupFragmentFromRow))
  return { items, total, hasMore: query.offset + items.length < total }
}

const FILTERED_SQL = `
WITH filtered AS (
  SELECT COALESCE(root_agent.execution_id, usage.execution_id) AS root_execution_id,
    usage.execution_id, usage.provider_id, usage.requested_model_id, usage.occurred_at,
    usage.total_tokens,
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
    workflow_node.workflow_run_id AS workflow_run_id
  FROM ai_model_call_usage AS usage
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
  WHERE usage.project_id = $1
    AND usage.occurred_at >= $2::timestamptz
    AND usage.occurred_at < $3::timestamptz
    AND ($4::text IS NULL OR usage.provider_id = $4)
    AND ($5::text IS NULL OR usage.requested_model_id = $5)
    AND ($6::text IS NULL OR COALESCE(cost.status, 'unvalued') = $6)
), roots AS (
  SELECT root_execution_id, MAX(occurred_at) AS last_call_at
  FROM filtered GROUP BY root_execution_id
)
`
const COUNT_SQL = `${FILTERED_SQL} SELECT CAST(COUNT(*) AS TEXT) AS total FROM roots`
const PAGE_SQL = `${FILTERED_SQL}, page AS (
  SELECT root_execution_id FROM roots
  ORDER BY last_call_at DESC, root_execution_id COLLATE "C" ASC LIMIT $7 OFFSET $8
)
SELECT filtered.root_execution_id, execution_id, provider_id, requested_model_id,
  MIN(occurred_at) AS first_call_at, MAX(occurred_at) AS last_call_at,
  CAST(COUNT(*) AS TEXT) AS call_count,
  CAST(COUNT(total_tokens) AS TEXT) AS token_count,
  CAST(SUM(total_tokens) AS TEXT) AS total_tokens,
  valuation_status, amount_currency,
  CAST(SUM(amount_nanos / 1000000000000) AS TEXT) AS amount_high,
  CAST(SUM((amount_nanos / 1000000) % 1000000) AS TEXT) AS amount_middle,
  CAST(SUM(amount_nanos % 1000000) AS TEXT) AS amount_low,
  MAX(root_agent_run_id) AS root_agent_run_id,
  MAX(root_thread_id) AS root_thread_id,
  MAX(direct_kind) AS direct_kind,
  MAX(direct_run_id) AS direct_run_id,
  MAX(parent_run_id) AS parent_run_id,
  MAX(workflow_agent_step_id) AS workflow_agent_step_id,
  MAX(workflow_node_run_id) AS workflow_node_run_id,
  MAX(workflow_id) AS workflow_id,
  MAX(workflow_run_id) AS workflow_run_id
FROM filtered JOIN page ON page.root_execution_id = filtered.root_execution_id
GROUP BY filtered.root_execution_id, execution_id, provider_id, requested_model_id,
  valuation_status, amount_currency
`
