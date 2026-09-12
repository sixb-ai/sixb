import type { AiAccountingAttribution } from "./types"

/** Direct calls are identified by durable provenance, even when their run has been removed. */
export function directModelCallAttribution(
  kind: string | null,
  id: string | null,
  primitiveId: string | null
): AiAccountingAttribution | undefined {
  if (!id) return undefined
  if (kind === "request") return { kind, requestId: id }
  if (kind === "action" && primitiveId) return { kind, actionId: primitiveId, actionRunId: id }
  if (kind === "workflow" && primitiveId)
    return { kind, workflowId: primitiveId, workflowRunId: id }
  return undefined
}
