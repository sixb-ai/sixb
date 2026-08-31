import {
  type AgentThreadModelContextMessage,
  projectAgentThreadModelContext,
} from "@sixb/core/internal/agents"
import type {
  AgentContextCheckpointRecord,
  AgentMessageRecord,
  AgentStorage,
} from "@sixb/core/storage"

export interface LoadedAgentThreadModelContext {
  readonly checkpoint: AgentContextCheckpointRecord | null
  readonly retainedMessages: readonly AgentMessageRecord[]
  readonly modelMessages: readonly AgentThreadModelContextMessage[]
}

/** Read only the retained tail and build the model-only checkpoint projection. */
export async function loadAgentThreadModelContext(input: {
  readonly storage: AgentStorage
  readonly projectId: string
  readonly threadId: string
}): Promise<LoadedAgentThreadModelContext> {
  const checkpoint = await input.storage.checkpoints.getLatest({
    projectId: input.projectId,
    threadId: input.threadId,
  })
  const history = await input.storage.messages.list({
    projectId: input.projectId,
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
