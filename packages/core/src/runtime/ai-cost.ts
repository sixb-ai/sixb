import type { AiCostStorage, AiCostSummary } from "../storage/ai-cost"

/** Resolve preferred cost summaries in input order without inventing unavailable accounting. */
export async function resolveExecutionCosts(input: {
  readonly storage: AiCostStorage | undefined
  readonly projectId: string
  readonly executionIds: readonly string[]
}): Promise<readonly (AiCostSummary | undefined)[]> {
  if (input.executionIds.length === 0) return []
  if (!input.storage) return input.executionIds.map(() => undefined)
  return input.storage.summarizeExecutions({
    projectId: input.projectId,
    executionIds: input.executionIds,
  })
}
