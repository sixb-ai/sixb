import type {
  CreateAgentThreadData,
  GetAgentResponse,
  GetAgentRunResponse,
  GetAgentThreadContextResponse,
  ListAgentThreadInboxResponse,
  ListAgentThreadMessagesResponse,
  ListAgentThreadsResponse,
  ListModelsResponse,
} from "@sixb/client"
import type { AgentContextEntryInput, AgentContextInput } from "@sixb/core/agents/context"
import type { ModelReasoningLevel } from "@sixb/core/models"

export type { AgentContextEntryInput, AgentContextInput }

// The generated client describes agent payloads as inline response shapes. Re-derive the row types
// here so the rest of the agent UI has stable, readable names to work with.

export type Agent = GetAgentResponse

export type AgentThread = ListAgentThreadsResponse["threads"][number]

/** What a new conversation's sandbox is made from, as the project's sandbox declares its params. */
export type AgentThreadSandboxParams = NonNullable<CreateAgentThreadData["body"]["sandbox"]>

export type AgentMessage = ListAgentThreadMessagesResponse["messages"][number]

export type AgentMessagePart = AgentMessage["parts"][number]

export type AgentFileRef = Extract<AgentMessagePart, { type: "file" }>["fileRef"]

export type AgentContextPart = Extract<AgentMessagePart, { type: "context" }>

/** A message waiting in a conversation's inbox: a steer, or a turn queued behind one. */
export type AgentInboxItem = ListAgentThreadInboxResponse["items"][number]

/** Where a message goes while a turn runs: into it, behind it, or after stopping it. */
export type AgentMessageDelivery = "auto" | "steer" | "queue" | "send_now"

export type AgentRun = GetAgentRunResponse

/** A conversation's context against its model's limits: what the context meter shows. */
export type AgentThreadContext = GetAgentThreadContextResponse

export type AgentRunStatus = AgentRun["status"]

export type LanguageModel = ListModelsResponse["language"][number]

export interface AgentModelSelection {
  readonly model: Pick<LanguageModel, "provider" | "modelId">
  readonly reasoning?: ModelReasoningLevel
}
