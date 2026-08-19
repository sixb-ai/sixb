import type { AiModelCallUsage, AiUsageStorage } from "@sixb/core/storage"

/** Read a public usage summary only from the durable model-call ledger. */
export async function resolveAiUsageSummary(input: {
  readonly storage: AiUsageStorage | undefined
  readonly projectId: string
  readonly executionId: string
}): Promise<AiModelCallUsage | undefined> {
  const [summary] = await resolveAiUsageSummaries({
    storage: input.storage,
    projectId: input.projectId,
    executionIds: [input.executionId],
  })
  return summary
}

/** Read multiple public usage summaries in one durable model-call ledger operation. */
export async function resolveAiUsageSummaries(input: {
  readonly storage: AiUsageStorage | undefined
  readonly projectId: string
  readonly executionIds: readonly string[]
}): Promise<readonly (AiModelCallUsage | undefined)[]> {
  if (!input.storage) return input.executionIds.map(() => undefined)

  const summaries = await input.storage.summarizeExecutions({
    projectId: input.projectId,
    executionIds: input.executionIds,
  })
  return summaries.map((summary) => (summary.modelCallCount === 0 ? undefined : summary.usage))
}
