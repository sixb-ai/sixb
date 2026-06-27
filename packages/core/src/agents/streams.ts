import type { BrokerStreamDefinition } from "../broker"
import type { JsonValue } from "../json"

export const AGENT_RUN_STREAM_SCHEMA_VERSION = 1 as const
export const DEFAULT_AGENT_RUN_STREAM_RETENTION = {
  maxAgeMs: 2 * 60 * 60 * 1000, // 2 hours
  maxRecords: 5_000,
} as const

export type AgentRunStreamId = `agents.runs.${string}`

export function agentRunStreamId(runId: string): AgentRunStreamId {
  return `agents.runs.${runId}`
}

export function agentRunStreamDefinition(runId: string): BrokerStreamDefinition {
  return {
    id: agentRunStreamId(runId),
    retention: DEFAULT_AGENT_RUN_STREAM_RETENTION,
  }
}

interface AgentRunStreamEventBase {
  readonly schemaVersion: typeof AGENT_RUN_STREAM_SCHEMA_VERSION
  readonly projectId: string
  readonly runId: string
  readonly threadId: string
  readonly agentId: string
  readonly attempt: number
  readonly occurredAt: string
}

export type AgentRunStreamEvent =
  | (AgentRunStreamEventBase & {
      readonly type: "agent.run.started"
      readonly modelId?: string
    })
  | (AgentRunStreamEventBase & {
      readonly type: "agent.ui.chunk"
      readonly chunkIndex: number
      readonly chunk: JsonValue
    })
  | (AgentRunStreamEventBase & {
      readonly type: "agent.message.finalized"
      readonly messageId: string
    })
  | (AgentRunStreamEventBase & {
      readonly type: "agent.run.finished"
      readonly status: "succeeded" | "failed" | "cancelled"
      readonly finishReason?: string
      readonly error?: string
    })
