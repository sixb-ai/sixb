import {
  type AgentRunConversation,
  type AgentThreadModelContextMessage,
  projectAgentThreadModelContext,
} from "@sixb/core/internal/agents"
import type { AgentContextCheckpointRecord, AgentMessageRecord } from "@sixb/core/storage"

export interface LoadedAgentThreadModelContext {
  readonly checkpoint: AgentContextCheckpointRecord | null
  readonly retainedMessages: readonly AgentMessageRecord[]
  readonly modelMessages: readonly AgentThreadModelContextMessage[]
}

/** Read only the retained tail and build the model-only checkpoint projection. */
export async function loadAgentThreadModelContext(input: {
  readonly conversation: Pick<AgentRunConversation, "latestCheckpoint" | "messages">
  readonly threadId: string
}): Promise<LoadedAgentThreadModelContext> {
  const checkpoint = await input.conversation.latestCheckpoint(input.threadId)
  const history = await input.conversation.messages({
    threadId: input.threadId,
    ...(checkpoint ? { afterSeq: checkpoint.summarizedThroughSeq } : {}),
    order: "asc",
  })
  return {
    checkpoint,
    retainedMessages: history.messages,
    modelMessages: projectAgentThreadModelContext({ checkpoint, messages: history.messages }),
  }
}
