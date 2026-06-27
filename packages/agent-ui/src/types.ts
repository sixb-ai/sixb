import type {
  GetAgentRunResponse,
  ListAgentsResponse,
  ListAgentThreadMessagesResponse,
  ListAgentThreadsResponse,
} from "@sixb/client"

// The generated client describes agent payloads as inline response shapes. Re-derive the row types
// here so the rest of the Atlas agents feature has stable, readable names to work with.

export type Agent = ListAgentsResponse[number]

export type AgentThread = ListAgentThreadsResponse["threads"][number]

export type AgentMessage = ListAgentThreadMessagesResponse["messages"][number]

export type AgentMessagePart = AgentMessage["parts"][number]

export type AgentRun = GetAgentRunResponse

export type AgentRunStatus = AgentRun["status"]
