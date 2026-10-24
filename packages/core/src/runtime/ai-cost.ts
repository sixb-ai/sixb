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

/** The cost of several executions together; nothing when none made a call. */
export function addCostSummaries(summaries: readonly AiCostSummary[]): AiCostSummary | undefined {
  const amounts = new Map<string, bigint>()
  let ratedCallCount = 0
  let unpriceableCallCount = 0
  let unvaluedCallCount = 0

  for (const summary of summaries) {
    for (const money of summary.amounts) {
      amounts.set(money.currency, (amounts.get(money.currency) ?? 0n) + BigInt(money.amountNanos))
    }
    ratedCallCount += summary.ratedCallCount
    unpriceableCallCount += summary.unpriceableCallCount
    unvaluedCallCount += summary.unvaluedCallCount
  }

  if (ratedCallCount + unpriceableCallCount + unvaluedCallCount === 0) {
    return undefined
  }

  return {
    amounts: [...amounts]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([currency, amount]) => ({ currency, amountNanos: amount.toString() })),
    ratedCallCount,
    unpriceableCallCount,
    unvaluedCallCount,
  }
}
