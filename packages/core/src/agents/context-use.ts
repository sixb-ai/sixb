import type { LanguageModel, ModelReasoning } from "../models"
import type { AgentContextCheckpointReason } from "../storage/agents"
import { type AgentContextBudget, resolveAgentContextBudget } from "./context-budget"
import { estimateAgentContextMessagesTokens } from "./context-compaction"
import { estimateAgentThreadRequest } from "./context-request"
import { readAgentContextTokenRates } from "./context-token-rate"
import {
  type AgentTurnHistory,
  type AgentTurnHistoryHost,
  readAgentThreadHistory,
} from "./run-turn"
import { projectAgentThreadModelContext } from "./thread-context-projection"

/**
 * What a thread's context weighs against a model's limits, as its next turn would see them: what
 * a context meter shows.
 */
export interface AgentThreadContextUse {
  readonly windowTokens: number
  /** The window less the output reserve: no request crosses it, and compaction starts past it. */
  readonly limitTokens: number
  /**
   * What the next request weighs, as the worker estimates it before a turn (see
   * estimateAgentThreadRequest), with the system prompt and tools the latest compaction counted:
   * the API cannot render them. Absent before the thread's first answer.
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
 * `reasoning`, from the bytes per token a turn's plan would start from.
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
  const tokenRates = await readAgentContextTokenRates({
    tokenRates: host.storage.agents.tokenRates,
    projectId: host.projectId,
    model: input.model,
  })
  const budget = resolveAgentContextBudget({
    model: input.model,
    ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
    tokenRates,
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

  const usedTokens = contextUsedTokens(history, input.model, budget)
  const checkpoint = history.checkpoint

  return {
    windowTokens: budget.windowTokens,
    limitTokens: budget.inputBudgetTokens,
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
 * What the next request to `model` weighs: the worker's estimate, without the system prompt and
 * tools it renders, and at least what the latest compaction left and the messages after the head
 * it saw, which counts them as of then. Undefined before the first answer.
 */
function contextUsedTokens(
  history: Pick<AgentTurnHistory, "checkpoint" | "messages" | "usageAnchor">,
  model: LanguageModel,
  budget: Pick<AgentContextBudget, "bytesPerToken" | "typicalBytesPerToken">
): number | undefined {
  const { checkpoint, messages } = history
  if (!checkpoint && !messages.some((message) => message.role === "assistant")) return undefined

  const estimate = estimateAgentThreadRequest({
    usageAnchor: history.usageAnchor,
    retainedMessages: messages,
    modelMessages: projectAgentThreadModelContext({ checkpoint, messages }),
    model,
    bytesPerToken: budget.bytesPerToken,
    ...(budget.typicalBytesPerToken === undefined
      ? {}
      : { typicalBytesPerToken: budget.typicalBytesPerToken }),
    systemPrompt: "",
    tools: [],
  })
  if (!checkpoint) return estimate.tokens

  const after = messages.filter((message) => message.seq > checkpoint.observedHeadSeq)
  return Math.max(
    estimate.tokens,
    checkpoint.estimatedInputTokensAfter +
      estimateAgentContextMessagesTokens(after, estimate.bytesPerToken).tokens
  )
}
