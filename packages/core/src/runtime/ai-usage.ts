import type { AiModelCallUsage, AiUsageStorage } from "../storage/ai-usage"

/** Resolve execution usage for runtime views without exposing the accounting provider. */
export async function resolveExecutionUsage(input: {
  readonly storage: AiUsageStorage | undefined
  readonly projectId: string
  readonly executionIds: readonly string[]
}): Promise<readonly (AiModelCallUsage | undefined)[]> {
  if (input.executionIds.length === 0) return []
  if (!input.storage) return input.executionIds.map(() => undefined)

  const summaries = await input.storage.summarizeExecutions({
    projectId: input.projectId,
    executionIds: input.executionIds,
  })
  return summaries.map((summary) => (summary.modelCallCount === 0 ? undefined : summary.usage))
}
