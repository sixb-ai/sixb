import type { normalizeAiAccountingQuery } from "@sixb/core/internal/ai-cost-storage-provider"

// The kind, source and requester filters every accounting read shares, over the joins it makes:
// `execution`, `direct_agent`, `workflow_node`.

/** Where a call came from, as `aiAccountingSource` reads its attribution. */
export const SQLITE_SOURCE_WORKFLOW = `COALESCE(
  workflow_node.workflow_id,
  CASE WHEN execution.executor_kind = 'workflow' THEN execution.authority_primitive_id END
)`
export const SQLITE_SOURCE_KIND = `CASE
  WHEN direct_agent.id IS NOT NULL THEN 'agent'
  WHEN ${SQLITE_SOURCE_WORKFLOW} IS NOT NULL THEN 'workflow'
  WHEN execution.executor_kind = 'action' THEN 'action'
  ELSE 'other'
END`

/** The kind, source and requester filters over the columns that hold them; 12 positional params. */
export function sqliteAccountingFilter(columns: {
  readonly kind: string
  readonly sourceKind: string
  readonly sourceWorkflow: string
  readonly userId: string
  readonly serviceAccountId: string
}): string {
  return `(? IS NULL OR ${columns.kind} = ?)
    AND (? IS NULL OR ${columns.sourceKind} = ?)
    AND (? IS NULL OR ${columns.sourceWorkflow} = ?)
    AND (
      ? IS NULL
      OR (? = 'none' AND ${columns.userId} IS NULL AND ${columns.serviceAccountId} IS NULL)
      OR (? = 'user' AND ${columns.userId} = ?)
      OR (? = 'serviceAccount' AND ${columns.serviceAccountId} = ?)
    )`
}

export function sqliteAccountingFilterParameters(
  query: ReturnType<typeof normalizeAiAccountingQuery>
): readonly (string | null)[] {
  const kind = query.modelKind ?? null
  const source = query.source?.kind ?? null
  const workflow = query.source?.kind === "workflow" ? (query.source.workflowId ?? null) : null
  const mode =
    query.requester === undefined
      ? null
      : query.requester === "none"
        ? "none"
        : query.requester.type
  const id = query.requester === undefined || query.requester === "none" ? null : query.requester.id
  return [kind, kind, source, source, workflow, workflow, mode, mode, mode, id, mode, id]
}
