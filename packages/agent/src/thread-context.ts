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

/** The retained tail with its checkpoint, projected for the model. */
export function agentThreadModelContext(history: AgentTurnHistory): LoadedAgentThreadModelContext {
  const { checkpoint, messages } = history
  return {
    checkpoint,
    retainedMessages: messages,
    modelMessages: projectAgentThreadModelContext({ checkpoint, messages }),
    history,
  }
}
