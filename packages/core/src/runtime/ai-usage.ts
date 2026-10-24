import type { AiModelCallUsage, AiModelCallUsageInput, AiUsageStorage } from "../storage/ai-usage"
import {
  AI_USAGE_FIELDS,
  aggregateAiModelCallUsage,
  normalizeAiModelCallUsage,
} from "../storage/ai-usage/usage"

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

/**
 * The usage of several executions together. When each knows its token totals, a count is summed
 * only where all of them know it, as their calls would be one by one. When one does not, such as a
 * child cut short mid-call, the total keeps what the others know: each count sums the executions
 * that know it, and the total is `partial`, a floor for what was spent.
 */
export function addUsageSummaries(
  usages: readonly AiModelCallUsage[]
): AiModelCallUsage | undefined {
  if (usages.length <= 1) return usages[0]
  if (usages.every((usage) => usage.reportingStatus === "complete")) {
    return aggregateAiModelCallUsage(usages)
  }

  const counts: AiModelCallUsageInput = Object.fromEntries(
    AI_USAGE_FIELDS.flatMap((field) => {
      const known = usages.flatMap((usage) => (usage[field] === undefined ? [] : [usage[field]]))
      return known.length === 0 ? [] : [[field, known.reduce((sum, count) => sum + count, 0)]]
    })
  )
  const total = normalizeAiModelCallUsage(counts)
  return usages.every((usage) => usage.reportingStatus === "unavailable")
    ? total
    : { ...total, reportingStatus: "partial" }
}
