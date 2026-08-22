import type { AgentRunActivityEvent, AgentRunStreamEvent } from "@sixb/core/agents/streams"
// Import the wire validator from the browser-safe streams subpath: the `@sixb/core` root pulls in
// node-only runtime (e.g. `node:crypto`), which breaks the Atlas browser bundle.
import { isAgentRunActivityEvent, isAgentRunStreamEvent } from "@sixb/core/agents/streams"
import type { BrokerRecord } from "@sixb/core/broker"
import type { GetAgentRunResponses } from "./generated/types.gen"
import {
  createReconnectingSocket,
  createSixbWebSocketUrl,
  type ReconnectingSocket,
  type ReconnectingSocketState,
} from "./ws-socket"

export type {
  AgentRunActivityEvent,
  AgentRunFailure,
  AgentRunStreamEvent,
} from "@sixb/core/agents/streams"
export type { ReconnectingSocket, ReconnectingSocketState } from "./ws-socket"

export type AgentRunSnapshot = GetAgentRunResponses[200]

export interface AgentRunStreamRecord extends Omit<BrokerRecord, "payload"> {
  readonly payload: AgentRunStreamEvent
}

export interface AgentRunStreamSubscribeMessage {
  readonly type: "subscribe"
  readonly runId: string
  readonly afterCursor?: string
}

export interface AgentRunStreamReplayMessage {
  readonly type: "replay"
  readonly runId: string
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
  | { readonly type: "subscribed.activity" }
  | { readonly type: "unsubscribed.activity" }
  | { readonly type: "activity"; readonly event: AgentRunActivityEvent }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "run.snapshot"; readonly run: AgentRunSnapshot }
  | { readonly type: "record"; readonly record: AgentRunStreamRecord }

export function createSixbAgentsWebSocketUrl(baseUrl?: string): string {
  return createSixbWebSocketUrl("/ws/agents", baseUrl)
}

export interface AgentRunSocketOptions {
  readonly runId: string
  readonly afterCursor?: string
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  /** Override the API base url. Defaults to the global client config. */
  readonly baseUrl?: string
  readonly onEvent: (event: AgentRunStreamEvent, cursor: string) => void
  readonly onRunSnapshot?: (run: AgentRunSnapshot) => void
  readonly onError?: (message: string) => void
  readonly onStateChange?: (state: ReconnectingSocketState) => void
}

export interface AgentActivitySocketOptions {
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  /** Override the API base url. Defaults to the global client config. */
  readonly baseUrl?: string
  readonly onActivity: (event: AgentRunActivityEvent) => void
  /** Called after each initial or reconnect subscription, so durable state can be reconciled. */
  readonly onSubscribed?: () => void
  readonly onError?: (message: string) => void
  readonly onStateChange?: (state: ReconnectingSocketState) => void
}

/**
 * Open a subscribing WebSocket to `/ws/agents` for one run and stream its records to `onEvent`.
 * Tracks the latest cursor across reconnects so no record is replayed. React-free: the
 * `useAgentRunStream` hook is a thin wrapper that mirrors the socket state into React state.
 */
export function createAgentRunSocket(options: AgentRunSocketOptions): ReconnectingSocket {
  let latestCursor = options.afterCursor

  return createReconnectingSocket({
    url: createSixbAgentsWebSocketUrl(options.baseUrl),
    reconnect: options.reconnect,
    reconnectDelayMs: options.reconnectDelayMs,
    connectionErrorMessage: "Agent stream websocket connection failed.",
    onError: options.onError,
    onStateChange: options.onStateChange,
    subscribeMessage: () =>
      ({
        type: "subscribe",
        runId: options.runId,
        ...(latestCursor ? { afterCursor: latestCursor } : {}),
      }) satisfies AgentRunStreamSubscribeMessage,
    onMessage: (data, sink) => {
      const message = parseAgentRunStreamServerMessage(data)
      if (!message) return

      if (message.type === "record") {
        latestCursor = message.record.cursor
        options.onEvent(message.record.payload, message.record.cursor)
        return
      }

      if (message.type === "run.snapshot") {
        options.onRunSnapshot?.(message.run)
        return
      }

      if (message.type === "error") {
        sink.reportError(message.message)
      }
    },
  })
}

/** Open one project-level lifecycle feed, independent of how many Agent threads are running. */
export function createAgentActivitySocket(options: AgentActivitySocketOptions): ReconnectingSocket {
  return createReconnectingSocket({
    url: createSixbAgentsWebSocketUrl(options.baseUrl),
    reconnect: options.reconnect,
    reconnectDelayMs: options.reconnectDelayMs,
    connectionErrorMessage: "Agent activity websocket connection failed.",
    onError: options.onError,
    onStateChange: options.onStateChange,
    subscribeMessage: () => ({ type: "subscribe.activity" }),
    onMessage: (data, sink) => {
      const message = parseAgentRunStreamServerMessage(data)
      if (!message) return
      if (message.type === "activity") {
        options.onActivity(message.event)
        return
      }
      if (message.type === "subscribed.activity") {
        options.onSubscribed?.()
        return
      }
      if (message.type === "error") sink.reportError(message.message)
    },
  })
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

  if (parsed.type === "run.snapshot" && isAgentRunSnapshot(parsed.run)) {
    return { type: "run.snapshot", run: parsed.run }
  }

  if (parsed.type === "error") {
    return { type: "error", message: String(parsed.message ?? "Agent stream error.") }
  }

  if (parsed.type === "activity" && isAgentRunActivityEvent(parsed.event)) {
    return { type: "activity", event: parsed.event }
  }

  if (parsed.type === "subscribed.activity" || parsed.type === "unsubscribed.activity") {
    return { type: parsed.type }
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

function isAgentRunSnapshot(value: unknown): value is AgentRunSnapshot {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.projectId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.agentId === "string" &&
    typeof value.triggerMessageId === "string" &&
    (value.requestedBy === undefined ||
      (isRecord(value.requestedBy) &&
        typeof value.requestedBy.type === "string" &&
        typeof value.requestedBy.id === "string")) &&
    isDurableAgentRunStatus(value.status) &&
    isFiniteNumber(value.attempt) &&
    typeof value.streamId === "string" &&
    typeof value.createdAt === "string"
  )
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

function isDurableAgentRunStatus(value: unknown): value is AgentRunSnapshot["status"] {
  return (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
