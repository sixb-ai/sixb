import type { AgentRunStreamEvent, BrokerRecord } from "@sixb/core"
// Import the schema-version value from the browser-safe streams subpath: the `@sixb/core` root pulls
// in node-only runtime (e.g. `node:crypto`), which breaks the Atlas browser bundle.
import { AGENT_RUN_STREAM_SCHEMA_VERSION } from "@sixb/core/agents/streams"
import { client } from "./generated/client.gen"

export type { AgentRunStreamEvent } from "@sixb/core"

export interface AgentRunStreamRecord extends Omit<BrokerRecord, "payload"> {
  readonly payload: AgentRunStreamEvent
}

export interface AgentRunStreamSubscribeMessage {
  readonly type: "subscribe"
  readonly runId: string
  readonly threadId?: string
  readonly afterCursor?: string
}

export interface AgentRunStreamReplayMessage {
  readonly type: "replay"
  readonly runId: string
  readonly threadId?: string
  readonly afterCursor?: string
  readonly limit?: number
}

export interface AgentRunStreamUnsubscribeMessage {
  readonly type: "unsubscribe"
  readonly runId?: string
}

export type AgentRunStreamClientMessage =
  | AgentRunStreamSubscribeMessage
  | AgentRunStreamReplayMessage
  | AgentRunStreamUnsubscribeMessage

export type AgentRunStreamServerMessage =
  | { readonly type: "connected"; readonly channel?: string }
  | { readonly type: "subscribed"; readonly runId: string; readonly afterCursor: string | null }
  | {
      readonly type: "replayed"
      readonly runId: string
      readonly afterCursor: string | null
      readonly count: number
    }
  | { readonly type: "unsubscribed"; readonly runId?: string | null }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "record"; readonly record: AgentRunStreamRecord }

const DEFAULT_SIXB_API_BASE_URL = "http://localhost:3002"

export function createSixbAgentsWebSocketUrl(baseUrl?: string): string {
  const url = new URL(baseUrl ?? client.getConfig().baseUrl ?? DEFAULT_SIXB_API_BASE_URL)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/ws/agents"
  url.search = ""
  url.hash = ""
  return url.toString()
}

export function parseAgentRunStreamServerMessage(
  value: unknown
): AgentRunStreamServerMessage | null {
  if (typeof value !== "string") {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return null
  }

  if (parsed.type === "record" && isAgentRunStreamRecord(parsed.record)) {
    return { type: "record", record: parsed.record }
  }

  if (parsed.type === "error") {
    return { type: "error", message: String(parsed.message ?? "Agent stream error.") }
  }

  if (parsed.type === "connected") {
    return {
      type: "connected",
      ...(typeof parsed.channel === "string" ? { channel: parsed.channel } : {}),
    }
  }

  if (parsed.type === "subscribed") {
    if (typeof parsed.runId !== "string") {
      return null
    }

    return {
      type: "subscribed",
      runId: parsed.runId,
      afterCursor: typeof parsed.afterCursor === "string" ? parsed.afterCursor : null,
    }
  }

  if (parsed.type === "replayed") {
    if (typeof parsed.runId !== "string" || !isFiniteNumber(parsed.count)) {
      return null
    }

    return {
      type: "replayed",
      runId: parsed.runId,
      afterCursor: typeof parsed.afterCursor === "string" ? parsed.afterCursor : null,
      count: parsed.count,
    }
  }

  if (parsed.type === "unsubscribed") {
    return {
      type: "unsubscribed",
      ...(typeof parsed.runId === "string" || parsed.runId === null ? { runId: parsed.runId } : {}),
    }
  }

  return null
}

function isAgentRunStreamRecord(value: unknown): value is AgentRunStreamRecord {
  return (
    isRecord(value) &&
    typeof value.streamId === "string" &&
    typeof value.cursor === "string" &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.key === undefined || typeof value.key === "string") &&
    typeof value.publishedAt === "string" &&
    isAgentRunStreamEvent(value.payload)
  )
}

function isAgentRunStreamEvent(value: unknown): value is AgentRunStreamEvent {
  if (
    !isRecord(value) ||
    value.schemaVersion !== AGENT_RUN_STREAM_SCHEMA_VERSION ||
    typeof value.projectId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.agentId !== "string" ||
    !isFiniteNumber(value.attempt) ||
    typeof value.occurredAt !== "string" ||
    typeof value.type !== "string"
  ) {
    return false
  }

  switch (value.type) {
    case "agent.run.started":
      return value.modelId === undefined || typeof value.modelId === "string"
    case "agent.ui.chunk":
      return Number.isInteger(value.chunkIndex) && Object.hasOwn(value, "chunk")
    case "agent.message.finalized":
      return typeof value.messageId === "string"
    case "agent.run.finished":
      return (
        isAgentRunStatus(value.status) &&
        (value.finishReason === undefined || typeof value.finishReason === "string") &&
        (value.error === undefined || typeof value.error === "string")
      )
    default:
      return false
  }
}

function isAgentRunStatus(value: unknown): value is "succeeded" | "failed" | "cancelled" {
  return value === "succeeded" || value === "failed" || value === "cancelled"
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
