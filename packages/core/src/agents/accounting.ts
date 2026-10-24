import { nearestOwner } from "../execution/lineage"
import { addCostSummaries, resolveExecutionCosts } from "../runtime/ai-cost"
import { addUsageSummaries, resolveExecutionUsage } from "../runtime/ai-usage"
import type { SixbRuntimeContext } from "../runtime/types"
import type { AiCostSummary } from "../storage/ai-cost"
import type { AiModelCallUsage } from "../storage/ai-usage"

/**
 * Each turn's usage and cost: its own calls and those of everything below it, its children and
 * what its tools ran, as Activity counts them. Each call counts once, toward the nearest turn above
 * it. A child still at work adds what it has spent so far, and so does a workflow a tool started,
 * also once the turn has ended: Activity counts it toward the conversation the same way. A child's
 * execution counts the same way when it is the one asked about.
 */
export async function resolveTurnAccounting(
  runtime: SixbRuntimeContext,
  executionIds: readonly string[]
): Promise<readonly { readonly usage?: AiModelCallUsage; readonly cost?: AiCostSummary }[]> {
  if (executionIds.length === 0) return []
  const { projectId, storage } = runtime

  const below = await storage.executions.listDescendants({ projectId, executionIds })
  const turns = new Set(executionIds)
  const parentOf = new Map(below.map(({ id, parentId }) => [id, parentId]))
  const turnOf = (executionId: string) =>
    nearestOwner(
      executionId,
      (id) => parentOf.get(id),
      (id) => turns.has(id)
    )

  const accounted = [...executionIds, ...below.map(({ id }) => id)]
  const [usages, costs] = await Promise.all([
    resolveExecutionUsage({ storage: storage.aiUsage, projectId, executionIds: accounted }),
    resolveExecutionCosts({ storage: storage.aiCosts, projectId, executionIds: accounted }),
  ])

  const usagesByTurn = new Map<string, AiModelCallUsage[]>()
  const costsByTurn = new Map<string, AiCostSummary[]>()
  accounted.forEach((executionId, index) => {
    const turn = turnOf(executionId)
    const usage = usages[index]
    const cost = costs[index]
    // Never: every execution listed descends from a turn asked about.
    if (turn === undefined) return

    if (usage) usagesByTurn.set(turn, [...(usagesByTurn.get(turn) ?? []), usage])
    if (cost) costsByTurn.set(turn, [...(costsByTurn.get(turn) ?? []), cost])
  })

  return executionIds.map((executionId) => {
    const usage = addUsageSummaries(usagesByTurn.get(executionId) ?? [])
    const cost = addCostSummaries(costsByTurn.get(executionId) ?? [])
    return {
      ...(usage === undefined ? {} : { usage }),
      ...(cost === undefined ? {} : { cost }),
    }
  })
}
