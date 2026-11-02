import type { LanguageModel, ModelReasoning } from "../models"
import type { AgentContextCheckpointReason } from "../storage/agents"
import { type AgentContextBudget, resolveAgentContextBudget } from "./context-budget"
import { estimateAgentContextMessagesTokens, fixedAgentContextSize } from "./context-compaction"
import { apportionAgentContextTokens } from "./context-parts"
import { estimateAgentThreadRequest } from "./context-request"
import { readAgentContextTokenRates } from "./context-token-rate"
import type { AgentContextPartName, AgentMessage, AgentStepRequestSize } from "./message"
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
   * estimateAgentThreadRequest), with the system prompt and tools the latest call sent: the API
   * cannot render them. Absent before the thread's first answer.
   */
  readonly usedTokens?: number
  /**
   * `usedTokens` by part, in the order a meter lists them. The split is an estimate (see
   * apportionAgentContextTokens); the parts add up to `usedTokens`, which is not one.
   */
  readonly parts?: readonly { readonly part: AgentContextPartName; readonly tokens: number }[]
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

  const used = contextUsed(history, input.model, budget)
  const checkpoint = history.checkpoint

  return {
    windowTokens: budget.windowTokens,
    limitTokens: budget.inputBudgetTokens,
    ...(used ? { usedTokens: used.tokens, parts: used.parts } : {}),
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
 * What the next request to `model` weighs, split by part: the worker's estimate, with the system
 * prompt and tools the latest call sent, as its step recorded them. Undefined before the first
 * answer.
 *
 * A thread whose calls recorded nothing (they predate the record) counts no prompt nor tools, and
 * after a compaction at least what it left and the messages after the head it saw, as of then.
 * With a record, the request is counted as it is now: what the summary and retained messages
 * weigh, which a compaction's own estimate, made at the rate its run started from, overstates.
 */
function contextUsed(
  history: Pick<AgentTurnHistory, "checkpoint" | "messages" | "usageAnchor">,
  model: LanguageModel,
  budget: Pick<AgentContextBudget, "bytesPerToken">
):
  | { readonly tokens: number; readonly parts: NonNullable<AgentThreadContextUse["parts"]> }
  | undefined {
  const { checkpoint, messages } = history
  if (!checkpoint && !messages.some((message) => message.role === "assistant")) return undefined

  const request = latestStepRequest(messages)
  const systemBytes = Object.values(request?.system ?? {}).reduce(
    (total, bytes) => total + (bytes ?? 0),
    0
  )
  const estimate = estimateAgentThreadRequest({
    usageAnchor: history.usageAnchor,
    retainedMessages: messages,
    modelMessages: projectAgentThreadModelContext({ checkpoint, messages }),
    model,
    bytesPerToken: budget.bytesPerToken,
    fixed: fixedAgentContextSize({
      systemBytes,
      tools: request?.tools ?? { count: 0, bytes: 0 },
    }),
    ...(request?.contextDirectory === undefined
      ? {}
      : { contextDirectory: request.contextDirectory }),
  })

  const after = checkpoint
    ? messages.filter((message) => message.seq > checkpoint.observedHeadSeq)
    : []
  const tokens =
    checkpoint && !request
      ? Math.max(
          estimate.tokens,
          checkpoint.estimatedInputTokensAfter +
            estimateAgentContextMessagesTokens(after, estimate.bytesPerToken).tokens
        )
      : estimate.tokens

  return {
    tokens,
    parts: apportionAgentContextTokens({
      totalTokens: tokens,
      prompt: { ...request?.system, tools: request?.tools.bytes ?? 0 },
      promptBytesPerToken: budget.bytesPerToken,
      history: estimate.history.parts,
      ...(estimate.history.images ? { images: estimate.history.images } : {}),
      bytesPerToken: estimate.bytesPerToken,
    }),
  }
}

/** The request the thread's latest recorded step sent: its last step-start that carries one. */
function latestStepRequest(messages: readonly AgentMessage[]): AgentStepRequestSize | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue

    for (const part of [...message.parts].reverse()) {
      if (part.type === "step-start" && part.request) return part.request
    }
  }
  return undefined
}
