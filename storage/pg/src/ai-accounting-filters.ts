import type { normalizeAiAccountingQuery } from "@sixb/core/internal/ai-cost-storage-provider"

// The kind, source and requester filters every accounting read shares, over the joins it makes:
// `usage`, `execution`, `direct_agent`, `workflow_node`.

/** The filter's values, each `null` when the query leaves that part open. */
export function pgAccountingFilterValues(query: ReturnType<typeof normalizeAiAccountingQuery>): {
  readonly kind: string | null
  readonly source: string | null
  readonly workflow: string | null
  readonly mode: string | null
  readonly id: string | null
} {
  return {
    kind: query.modelKind ?? null,
    source: query.source?.kind ?? null,
    workflow: query.source?.kind === "workflow" ? (query.source.workflowId ?? null) : null,
    mode:
      query.requester === undefined
        ? null
        : query.requester === "none"
          ? "none"
          : query.requester.type,
    id: query.requester === undefined || query.requester === "none" ? null : query.requester.id,
  }
}

/** The filter as SQL text over numbered `$n` parameters from `start`, for `sql.unsafe`. */
export function pgAccountingFilterSql(start: number): string {
  const [kind, source, workflow, mode, id] = [0, 1, 2, 3, 4].map((offset) => `$${start + offset}`)
  const sourceWorkflow = `COALESCE(workflow_node.workflow_id,
    CASE WHEN execution.executor_kind = 'workflow' THEN execution.authority_primitive_id END)`
  return `(${kind}::text IS NULL OR usage.model_kind = ${kind})
    AND (${source}::text IS NULL OR (CASE
      WHEN direct_agent.id IS NOT NULL THEN 'agent'
      WHEN ${sourceWorkflow} IS NOT NULL THEN 'workflow'
      WHEN execution.executor_kind = 'action' THEN 'action'
      ELSE 'other'
    END) = ${source})
    AND (${workflow}::text IS NULL OR ${sourceWorkflow} = ${workflow})
    AND (
      ${mode}::text IS NULL
      OR (${mode} = 'none' AND execution.requested_by_user_id IS NULL
        AND execution.requested_by_service_account_id IS NULL)
      OR (${mode} = 'user' AND execution.requested_by_user_id = ${id})
      OR (${mode} = 'serviceAccount' AND execution.requested_by_service_account_id = ${id})
    )`
}
