import {
  type AgentThreadModelContextMessage,
  type AgentTurnHistory,
  projectAgentThreadModelContext,
} from "@sixb/core/internal/agents"
import type { AgentContextCheckpointRecord, AgentMessageRecord } from "@sixb/core/storage"

export interface LoadedAgentThreadModelContext {
  readonly checkpoint: AgentContextCheckpointRecord | null
  readonly retainedMessages: readonly AgentMessageRecord[]
  readonly modelMessages: readonly AgentThreadModelContextMessage[]
  /** The history it was built from, as the session answered it. */
  readonly history: AgentTurnHistory
}

/**
 * The retained tail with its checkpoint, projected for the model. A child's run reads its thread
 * without `historyReadable`: `sixb history` prints only a conversation's.
 */
export function agentThreadModelContext(
  history: AgentTurnHistory,
  options: { readonly historyReadable?: boolean } = {}
): LoadedAgentThreadModelContext {
  const { checkpoint, messages } = history
  return {
    checkpoint,
    retainedMessages: messages,
    modelMessages: projectAgentThreadModelContext({ checkpoint, messages, ...options }),
    history,
  }
}
