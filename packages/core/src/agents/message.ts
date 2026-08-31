import type { ProviderData } from "@sixb/llm"
import type { FileRef } from "../blob-storage"
import type { JsonValue } from "../json"
import type { AgentContextPart } from "./context"

/**
 * The agent's own, SDK-independent message. We store messages and threads — not an SDK transport —
 * so a message is just a `role` plus structured `parts` (and optional `metadata`). There is no
 * self-describing wrapper: the storage row owns the message's identity, and `contentVersion` (a
 * column) versions the parts shape so it can be migrated.
 *
 * The part union is intentionally focused on what agent runs actually produce (text, reasoning, step
 * boundaries, tool calls). It is extensible: adding a part kind later is non-breaking. The adapter
 * `fromUiMessage` is total — it throws on any part it cannot model rather than dropping it silently,
 * which both prevents data loss and signals exactly when the union must grow.
 */
export const AGENT_MESSAGE_CONTENT_VERSION = 2 as const

export type AgentMessageRole = "system" | "user" | "assistant"

/** A plain text part (assistant output, user input, or system text). */
export interface AgentTextPart {
  readonly type: "text"
  readonly text: string
  /** Provider passthrough (kept because some providers require it on the next turn). */
  readonly providerMetadata?: ProviderData
}

/**
 * A reasoning ("thinking") part. `providerMetadata` is load-bearing here: some providers require
 * the reasoning signature back on the following turn, so dropping it would break multi-step loops.
 */
export interface AgentReasoningPart {
  readonly type: "reasoning"
  readonly text: string
  readonly providerMetadata?: ProviderData
}

/** A step boundary between assistant loop iterations. */
export interface AgentStepStartPart {
  readonly type: "step-start"
}

/** A blob-backed file attached to a user message or produced by an agent/tool. */
export interface AgentFilePart {
  readonly type: "file"
  readonly fileRef: FileRef
  /** Provider passthrough for future model-specific file handling. */
  readonly providerMetadata?: ProviderData
}

interface AgentToolCallBase {
  readonly type: "tool-call"
  readonly toolCallId: string
  readonly toolName: string
  /** `true` when reconstructed from a dynamic tool part (vs a static `tool-${name}` part). */
  readonly dynamic?: boolean
  /** `true` when the provider executed the tool inline (steers model projection). */
  readonly providerExecuted?: boolean
  readonly input: JsonValue
  readonly providerMetadata?: ProviderData
}

/** Ordered, hidden provider state required to replay a model response losslessly. */
export interface AgentProviderStatePart {
  readonly type: "provider-state"
  readonly providerId: string
  readonly data: JsonValue
}

/**
 * A completed tool call. Only terminal states are modelled — transient states
 * (`input-streaming`, `input-available`, `approval-*`) are never persisted because messages are
 * written only once a run finishes.
 */
export type AgentToolCallPart = AgentToolCallBase &
  (
    | { readonly state: "output-available"; readonly output: JsonValue }
    | { readonly state: "output-error"; readonly errorText: string }
  )

export type AgentMessagePart =
  | AgentTextPart
  | AgentReasoningPart
  | AgentStepStartPart
  | AgentFilePart
  | AgentContextPart
  | AgentToolCallPart
  | AgentProviderStatePart

export type AgentMessagePartType = AgentMessagePart["type"]
export type AgentToolCallState = AgentToolCallPart["state"]

/** The logical agent message the adapters speak and the store persists (as columns). */
export interface AgentMessage {
  readonly role: AgentMessageRole
  readonly parts: readonly AgentMessagePart[]
  /** Message-level metadata (mirrors `UIMessage.metadata`). */
  readonly metadata?: JsonValue
}
