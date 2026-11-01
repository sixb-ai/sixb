import type { LanguageModel, ModelReasoning } from "../models"
import type { AgentContextCheckpointReason } from "../storage/agents"
import {
  type AgentContextTarget,
  expectedRemainingAgentCalls,
  resolveAgentContextBudget,
  resolveAgentContextTarget,
} from "./context-budget"
import { estimateAgentContextMessagesTokens } from "./context-compaction"
import {
  type AgentTurnHistory,
  type AgentTurnHistoryHost,
  matchingAgentUsageAnchor,
  readAgentThreadHistory,
} from "./run-turn"

/**
 * What a thread's context weighs against a model's limits, as its next turn would see them: what
 * a context meter shows.
 */
export interface AgentThreadContextUse {
  readonly windowTokens: number
  /** The hard limit: the window less the output reserve. No request crosses it. */
  readonly limitTokens: number
  /** Where the next turn keeps the context: compaction starts past it. */
  readonly target: Pick<AgentContextTarget, "tokens" | "limit" | "tier">
  /**
   * What the next request starts from: the last call's input and the answer it wrote, as the
   * provider counted them, when the worker would anchor on that call. Otherwise an estimate: what
   * the latest compaction left and the messages after it, without the system prompt and tools of a
   * conversation never condensed. Absent before the thread's first answer.
   */
  readonly usedTokens?: number
  /** The latest call the thread's history ends with, as the provider counted it. */
  readonly lastCall?: {
    readonly inputTokens: number
    readonly outputTokens?: number
    readonly cacheReadInputTokens?: number
    readonly occurredAt: Date
  }
  readonly lastCompaction?: {
    readonly reason: AgentContextCheckpointReason
    readonly createdAt: Date
    readonly estimatedInputTokensBefore: number
    readonly estimatedInputTokensAfter: number
  }
}

/**
 * Read a thread's context use for `model`: its history as a turn reads it, the call that history
 * ends with, and the model's limits resolved as the worker resolves them for a turn run with
 * `reasoning`.
 */
export async function readAgentThreadContextUse(
  host: AgentTurnHistoryHost,
  input: {
    readonly threadId: string
    readonly model: LanguageModel
    readonly reasoning?: ModelReasoning
  }
): Promise<AgentThreadContextUse> {
  const history = await readAgentThreadHistory(host, input.threadId)
  const budget = resolveAgentContextBudget({
    model: input.model,
    ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
  })
  const target = resolveAgentContextTarget(budget, {
    expectedRemainingCalls: expectedRemainingAgentCalls(history),
  })

  const call = history.usageAnchor?.modelCall
  const inputTokens = call?.usage.inputTokens
  const lastCall =
    call && inputTokens !== undefined && inputTokens > 0
      ? {
          inputTokens,
          ...(call.usage.outputTokens === undefined
            ? {}
            : { outputTokens: call.usage.outputTokens }),
          ...(call.usage.cacheReadInputTokens === undefined
            ? {}
            : { cacheReadInputTokens: call.usage.cacheReadInputTokens }),
          occurredAt: call.occurredAt,
        }
      : undefined

  const usedTokens = contextUsedTokens(history, input.model, budget.bytesPerToken)
  const checkpoint = history.checkpoint

  return {
    windowTokens: budget.windowTokens,
    limitTokens: budget.inputBudgetTokens,
    target: {
      tokens: target.tokens,
      limit: target.limit,
      ...(target.tier ? { tier: target.tier } : {}),
    },
    ...(usedTokens === undefined ? {} : { usedTokens }),
    ...(lastCall ? { lastCall } : {}),
    ...(checkpoint
      ? {
          lastCompaction: {
            reason: checkpoint.reason,
            createdAt: checkpoint.createdAt,
            estimatedInputTokensBefore: checkpoint.estimatedInputTokensBefore,
            estimatedInputTokensAfter: checkpoint.estimatedInputTokensAfter,
          },
        }
      : {}),
  }
}

/**
 * What the next request to `model` starts from. The call the history ends with counts it when
 * the worker would anchor on that call too: its input and the answer it wrote. Otherwise it is
 * estimated: what the latest compaction left, and the messages after the head it saw. Undefined
 * before the first answer.
 */
function contextUsedTokens(
  history: Pick<AgentTurnHistory, "checkpoint" | "messages" | "usageAnchor">,
  model: LanguageModel,
  bytesPerToken: number
): number | undefined {
  const anchor = matchingAgentUsageAnchor(history, model)
  if (anchor) return anchor.inputTokens + anchor.outputTokens

  const checkpoint = history.checkpoint
  if (!checkpoint && !history.messages.some((message) => message.role === "assistant")) {
    return undefined
  }

  const after = history.messages.filter(
    (message) => message.seq > (checkpoint?.observedHeadSeq ?? 0)
  )
  return (
    (checkpoint?.estimatedInputTokensAfter ?? 0) +
    estimateAgentContextMessagesTokens(after, bytesPerToken).tokens
  )
}
