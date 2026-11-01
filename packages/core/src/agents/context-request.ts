import type { AgentMessageRecord } from "../storage/agents/types"
import {
  type AgentContextEstimateTool,
  type AgentContextHistorySize,
  type AgentContextSize,
  addAgentContextSizes,
  agentContextSizeTokens,
  estimateAgentContextMessagesTokens,
  measureAgentContextFixed,
  measureAgentContextHistory,
} from "./context-compaction"
import { calibrateAgentContextBytesPerToken } from "./context-token-rate"
import { type AgentTurnHistory, matchingAgentUsageAnchor } from "./run-turn"
import type { AgentThreadModelContextMessage } from "./thread-context-projection"

/** A thread's next request, as an estimate of it counts it. */
export type AgentThreadRequestEstimateInput = AgentThreadHistoryEstimateInput &
  (
    | {
        /** What the request carries besides the history. */
        readonly systemPrompt: string
        readonly tools: readonly AgentContextEstimateTool[]
      }
    | {
        /** The same, as a step's recorded request measured it (see fixedAgentContextSize). */
        readonly fixed: AgentContextSize
      }
  )

interface AgentThreadHistoryEstimateInput {
  /** The call the history ends with, which anchors the estimate when it is the model's. */
  readonly usageAnchor: AgentTurnHistory["usageAnchor"]
  /** The messages after the checkpoint, oldest first: what the anchor names. */
  readonly retainedMessages: readonly AgentMessageRecord[]
  /** The history as the model reads it: the checkpoint's summary, then the retained messages. */
  readonly modelMessages: readonly AgentThreadModelContextMessage[]
  readonly model: { readonly providerId: string; readonly modelId: string }
  /** The bytes per token the run starts from, which the anchor calibrates. */
  readonly bytesPerToken: number
  /** Messages every request sends ahead of the history: a child's task, once summarized. */
  readonly head?: readonly AgentThreadModelContextMessage[]
  /** Where the run's context files are, for the history's split to name the ones it read. */
  readonly contextDirectory?: string
}

/**
 * A thread's next request as the model will count it, and the bytes per token it was counted at:
 * what the worker compacts by, and what a context meter shows. When the call the history ends with
 * is this model's, its real tokens anchor the estimate, and the input it carried (everything before
 * that answer's last step) measures the thread's own rate. The whole request estimated still wins
 * when larger: a new system prompt or tool catalog is not in the anchor, and an image counts as the
 * most a provider charges for one.
 */
export function estimateAgentThreadRequest(input: AgentThreadRequestEstimateInput): {
  readonly tokens: number
  readonly bytesPerToken: number
  /** The history the request sends, measured and split by part. */
  readonly history: AgentContextHistorySize
} {
  const { retainedMessages, modelMessages } = input
  const head = input.head ?? []
  const fixed = "fixed" in input ? input.fixed : measureAgentContextFixed(input)
  const history = measureAgentContextHistory({
    messages: [...head, ...modelMessages],
    ...(input.contextDirectory === undefined ? {} : { contextDirectory: input.contextDirectory }),
  })
  const full = (bytesPerToken: number) =>
    agentContextSizeTokens(addAgentContextSizes(fixed, history), bytesPerToken)

  const anchor = matchingAgentUsageAnchor(
    { usageAnchor: input.usageAnchor, messages: retainedMessages },
    input.model
  )
  if (!anchor) {
    return { tokens: full(input.bytesPerToken), bytesPerToken: input.bytesPerToken, history }
  }

  // The synthetic summary leads the model messages; the retained tail follows it.
  const offset = modelMessages.length - retainedMessages.length
  const answer = retainedMessages[anchor.index]!
  const lastStep = answer.parts.map((part) => part.type).lastIndexOf("step-start")
  const answered = lastStep > 0 ? [{ ...answer, parts: answer.parts.slice(0, lastStep) }] : []
  const bytesPerToken = calibrateAgentContextBytesPerToken({
    bytesPerToken: input.bytesPerToken,
    inputTokens: anchor.inputTokens,
    size: addAgentContextSizes(
      fixed,
      measureAgentContextHistory({
        messages: [...head, ...modelMessages.slice(0, offset + anchor.index), ...answered],
      })
    ),
  })

  const anchored =
    anchor.inputTokens +
    anchor.outputTokens +
    estimateAgentContextMessagesTokens(retainedMessages.slice(anchor.index + 1), bytesPerToken)
      .tokens
  return { tokens: Math.max(anchored, full(bytesPerToken)), bytesPerToken, history }
}
