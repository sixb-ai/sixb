import type {
  GetAgentRunResponse,
  ListAgentsResponse,
  ListAgentThreadMessagesResponse,
  ListAgentThreadsResponse,
  ListModelsResponse,
} from "@sixb/client"
import type { AgentReasoningLevel } from "@sixb/core"
import type { AgentContextEntryInput, AgentContextInput } from "@sixb/core/agents/context"

export type { AgentContextEntryInput, AgentContextInput }

// The generated client describes agent payloads as inline response shapes. Re-derive the row types
// here so the rest of the agent UI has stable, readable names to work with.

export type Agent = ListAgentsResponse[number]

export type AgentThread = ListAgentThreadsResponse["threads"][number]

export type AgentMessage = ListAgentThreadMessagesResponse["messages"][number]

export type AgentMessagePart = AgentMessage["parts"][number]

export type AgentFileRef = Extract<AgentMessagePart, { type: "file" }>["fileRef"]

export type AgentContextPart = Extract<AgentMessagePart, { type: "context" }>

export type AgentRun = GetAgentRunResponse

export type AgentRunStatus = AgentRun["status"]

export type LanguageModel = ListModelsResponse["language"][number]

export interface AgentModelSelection {
  readonly model: Pick<LanguageModel, "provider" | "modelId">
  readonly reasoning?: AgentReasoningLevel
}
