import type { AiModelCallUsage, AiUsageExecutionIdentity, AiUsageStorage } from "@sixb/core/storage"

/** Read a run summary only from the durable model-call ledger. */
export async function resolveAiUsageSummary(input: {
  readonly storage: AiUsageStorage | undefined
  readonly projectId: string
  readonly execution: AiUsageExecutionIdentity
}): Promise<AiModelCallUsage | undefined> {
  const [summary] = await resolveAiUsageSummaries({
    storage: input.storage,
    projectId: input.projectId,
    executions: [input.execution],
  })
  return summary
}

/** Read multiple run summaries in one durable model-call ledger operation. */
export async function resolveAiUsageSummaries(input: {
  readonly storage: AiUsageStorage | undefined
  readonly projectId: string
  readonly executions: readonly AiUsageExecutionIdentity[]
}): Promise<readonly (AiModelCallUsage | undefined)[]> {
  if (!input.storage) return input.executions.map(() => undefined)

  const summaries = await input.storage.summarizeExecutions({
    projectId: input.projectId,
    executions: input.executions,
  })
  return summaries.map((summary) => (summary.modelCallCount === 0 ? undefined : summary.usage))
}
