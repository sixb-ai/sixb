import { getInvalidJsonValueReason, type JsonValue } from "../json"
import { AgentMessageAdapterError } from "./errors"
import type { SixbMessage, SixbMessagePart, SixbMessageRole } from "./message"

// ── Inbound (write) — deliberately WIDE ────────────────────────────────────────────────────────
//
// `fromAiSdk` is the safety net at the SDK boundary, so its input is intentionally permissive: any
// `{ type: string }` part is accepted at the type level and narrowed at runtime. This is a
// structural supertype of the AI SDK's `UIMessage`, so a real SDK message can be passed without a
// cast (verified by a compat test in the consumer package, where `ai` lives — core stays SDK-free).

export interface SixbInboundUiMessagePart {
  readonly type: string
  readonly text?: string
  readonly state?: string
  // v6 types provider metadata as `Record<string, JSONObject>`, so we constrain it to JSON. `input`,
  // `output` and `rawInput` stay `unknown` — they are the tool's generic schema types, which we
  // cannot know at this boundary (no tool registry), and which fromAiSdk validates to JSON anyway.
  readonly providerMetadata?: JsonValue
  readonly toolName?: string
  readonly toolCallId?: string
  readonly providerExecuted?: boolean
  readonly input?: unknown
  readonly rawInput?: unknown
  readonly output?: unknown
  readonly errorText?: string
  readonly callProviderMetadata?: JsonValue
}

export interface SixbInboundUiMessage {
  readonly role: string
  readonly id?: string
  readonly metadata?: unknown
  readonly parts: readonly SixbInboundUiMessagePart[]
}

// ── Outbound (read) — PRECISE, aligned with AI SDK v6 ───────────────────────────────────────────

interface SixbUiToolPartBody {
  readonly toolCallId: string
  readonly providerExecuted?: boolean
  readonly callProviderMetadata?: JsonValue
}

export type SixbUiToolPart =
  | ({ readonly type: `tool-${string}` } & SixbUiToolPartBody &
      (
        | {
            readonly state: "output-available"
            readonly input: JsonValue
            readonly output: JsonValue
          }
        | { readonly state: "output-error"; readonly input: JsonValue; readonly errorText: string }
      ))
  | ({ readonly type: "dynamic-tool"; readonly toolName: string } & SixbUiToolPartBody &
      (
        | {
            readonly state: "output-available"
            readonly input: JsonValue
            readonly output: JsonValue
          }
        | { readonly state: "output-error"; readonly input: JsonValue; readonly errorText: string }
      ))

export type SixbUiMessagePart =
  | { readonly type: "text"; readonly text: string; readonly providerMetadata?: JsonValue }
  | { readonly type: "reasoning"; readonly text: string; readonly providerMetadata?: JsonValue }
  | { readonly type: "step-start" }
  | SixbUiToolPart

export interface SixbUiMessage {
  readonly role: SixbMessageRole
  readonly id?: string
  readonly metadata?: JsonValue
  readonly parts: readonly SixbUiMessagePart[]
}

export type SixbModelToolOutput =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "json"; readonly value: JsonValue }
  | { readonly type: "error-text"; readonly value: string }
  | { readonly type: "error-json"; readonly value: JsonValue }

export interface SixbModelTextPart {
  readonly type: "text"
  readonly text: string
  readonly providerOptions?: JsonValue
}
export interface SixbModelReasoningPart {
  readonly type: "reasoning"
  readonly text: string
  readonly providerOptions?: JsonValue
}
export interface SixbModelToolCallPart {
  readonly type: "tool-call"
  readonly toolCallId: string
  readonly toolName: string
  readonly input: JsonValue
  readonly providerExecuted?: boolean
  readonly providerOptions?: JsonValue
}
export interface SixbModelToolResultPart {
  readonly type: "tool-result"
  readonly toolCallId: string
  readonly toolName: string
  readonly output: SixbModelToolOutput
  readonly providerOptions?: JsonValue
}

export type SixbModelAssistantPart =
  | SixbModelTextPart
  | SixbModelReasoningPart
  | SixbModelToolCallPart
  | SixbModelToolResultPart

export type SixbModelMessage =
  | { readonly role: "system"; readonly content: string; readonly providerOptions?: JsonValue }
  | { readonly role: "user"; readonly content: readonly SixbModelTextPart[] }
  | { readonly role: "assistant"; readonly content: readonly SixbModelAssistantPart[] }
  | { readonly role: "tool"; readonly content: readonly SixbModelToolResultPart[] }

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

const TOOL_TYPE_PREFIX = "tool-"

function assertAdapter(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new AgentMessageAdapterError(`[Sixb] ${message}`)
  }
}

/**
 * Validate that `value` is a JSON-canonical value and return it as {@link JsonValue}. Out-of-contract
 * inputs (`undefined` inside objects, `Date`, `bigint`, `Map`/`Set`, non-finite numbers) throw rather
 * than being silently coerced by `JSON.stringify` downstream.
 */
function requireJson(value: unknown, label: string): JsonValue {
  const reason = getInvalidJsonValueReason(value, label)
  assertAdapter(reason === undefined, `agent message ${label} must be a JSON value; ${reason}`)
  return value as JsonValue
}

function optionalJson(value: unknown, label: string): JsonValue | undefined {
  return value === undefined ? undefined : requireJson(value, label)
}

function isToolType(type: string): boolean {
  return type === "dynamic-tool" || type.startsWith(TOOL_TYPE_PREFIX)
}

function toolNameFromInbound(part: SixbInboundUiMessagePart): string {
  if (part.type === "dynamic-tool") {
    assertAdapter(
      typeof part.toolName === "string" && part.toolName.length > 0,
      "dynamic-tool part is missing a tool name"
    )
    return part.toolName
  }
  const name = part.type.slice(TOOL_TYPE_PREFIX.length)
  assertAdapter(name.length > 0, `tool part type '${part.type}' is missing a tool name`)
  return name
}

// ── fromAiSdk (write) ─────────────────────────────────────────────────────────────────────────

/**
 * Convert an SDK-shaped UI message into a durable {@link SixbMessage}. Total: throws
 * {@link AgentMessageAdapterError} on any part kind, tool state, or text/reasoning state that V1 does
 * not model, and on a role outside `system | user | assistant`. Transient states are rejected
 * because messages are only ever persisted once a run has finished.
 */
export function fromAiSdk(message: SixbInboundUiMessage): SixbMessage {
  const { role } = message
  assertAdapter(
    role === "system" || role === "user" || role === "assistant",
    `unsupported message role '${role}'`
  )

  const parts: SixbMessagePart[] = message.parts.map((part) => fromAiSdkPart(part))
  const metadata = optionalJson(message.metadata, "metadata")

  return {
    role,
    parts,
    ...(metadata === undefined ? {} : { metadata }),
  }
}

function fromAiSdkPart(part: SixbInboundUiMessagePart): SixbMessagePart {
  switch (part.type) {
    case "text":
    case "reasoning": {
      assertAdapter(typeof part.text === "string", `${part.type} part is missing text`)
      assertAdapter(
        part.state !== "streaming",
        `cannot persist a streaming ${part.type} part; messages are written only once finalized`
      )
      const providerMetadata = optionalJson(part.providerMetadata, `${part.type}.providerMetadata`)
      return {
        type: part.type,
        text: part.text,
        ...(providerMetadata === undefined ? {} : { providerMetadata }),
      }
    }
    case "step-start":
      return { type: "step-start" }
    default: {
      assertAdapter(
        isToolType(part.type),
        `unsupported message part type '${part.type}'; extend the Sixb message part union to support it`
      )
      return fromAiSdkToolPart(part)
    }
  }
}

function fromAiSdkToolPart(part: SixbInboundUiMessagePart): SixbToolCallPartResult {
  const dynamic = part.type === "dynamic-tool"
  const toolName = toolNameFromInbound(part)
  assertAdapter(
    typeof part.toolCallId === "string" && part.toolCallId.length > 0,
    `tool part '${part.type}' is missing a toolCallId`
  )
  assertAdapter(
    part.state === "output-available" || part.state === "output-error",
    `cannot persist tool part '${part.toolCallId}' in transient state '${part.state}'; only terminal states are stored`
  )

  // For output-error the SDK input may be `undefined`; coerce to `null` to stay JSON-canonical.
  const input = part.input === undefined ? null : requireJson(part.input, "tool input")
  const providerMetadata = optionalJson(part.callProviderMetadata, "tool callProviderMetadata")

  const base = {
    type: "tool-call" as const,
    toolCallId: part.toolCallId,
    toolName,
    input,
    ...(dynamic ? { dynamic: true } : {}),
    ...(part.providerExecuted === undefined ? {} : { providerExecuted: part.providerExecuted }),
    ...(providerMetadata === undefined ? {} : { providerMetadata }),
  }

  if (part.state === "output-available") {
    return { ...base, state: "output-available", output: requireJson(part.output, "tool output") }
  }
  assertAdapter(
    typeof part.errorText === "string",
    `tool part '${part.toolCallId}' is missing errorText`
  )
  return { ...base, state: "output-error", errorText: part.errorText }
}

type SixbToolCallPartResult = Extract<SixbMessagePart, { type: "tool-call" }>

// ── toUiMessage (read) ────────────────────────────────────────────────────────────────────────

/** Reconstruct an SDK-shaped UI message from a stored message. Exact inverse of {@link fromAiSdk}. */
export function toUiMessage(message: SixbMessage): SixbUiMessage {
  return {
    role: message.role,
    parts: message.parts.map((part) => toUiPart(part)),
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
  }
}

function toUiPart(part: SixbMessagePart): SixbUiMessagePart {
  switch (part.type) {
    case "text":
    case "reasoning":
      return {
        type: part.type,
        text: part.text,
        ...(part.providerMetadata === undefined ? {} : { providerMetadata: part.providerMetadata }),
      }
    case "step-start":
      return { type: "step-start" }
    case "tool-call":
      return toUiToolPart(part)
  }
}

function toUiToolPart(part: SixbToolCallPartResult): SixbUiToolPart {
  const body = {
    toolCallId: part.toolCallId,
    ...(part.providerExecuted === undefined ? {} : { providerExecuted: part.providerExecuted }),
    ...(part.providerMetadata === undefined ? {} : { callProviderMetadata: part.providerMetadata }),
  }
  const state =
    part.state === "output-available"
      ? { state: "output-available" as const, input: part.input, output: part.output }
      : { state: "output-error" as const, input: part.input, errorText: part.errorText }

  if (part.dynamic) {
    return { type: "dynamic-tool", toolName: part.toolName, ...body, ...state }
  }
  return { type: `tool-${part.toolName}`, ...body, ...state }
}

// ── toModelMessages (read) ──────────────────────────────────────────────────────────────────────

/**
 * Project messages into AI SDK v6 `ModelMessage`s for replay into a model. The assistant/tool split
 * is hand-rolled to mirror `convertToModelMessages` (no `ai` import): assistant parts are grouped
 * into blocks at each `step-start`; each block yields one `assistant` message plus, for any
 * non-provider-executed tool calls, one `tool` message. Provider-executed tool results stay inline
 * in the assistant message. Without a tool registry, a string output maps to `text` and anything
 * else to `json`; this is the documented V1 fidelity scope (a tool's custom `toModelOutput` is not
 * reproduced).
 */
export function toModelMessages(messages: readonly SixbMessage[]): SixbModelMessage[] {
  const result: SixbModelMessage[] = []
  for (const message of messages) {
    switch (message.role) {
      case "system":
        result.push(systemModelMessage(message))
        break
      case "user":
        result.push(userModelMessage(message))
        break
      case "assistant":
        appendAssistantModelMessages(result, message)
        break
    }
  }
  return result
}

function systemModelMessage(message: SixbMessage): SixbModelMessage {
  const textParts = message.parts.filter(isTextPart)
  // Mirror convertToModelMessages: merge providerMetadata across all system text parts (carries e.g.
  // a provider's prompt-cache directive) and forward it as providerOptions when non-empty.
  const providerOptions = mergeProviderMetadata(textParts)
  return {
    role: "system",
    content: textParts.map((part) => part.text).join(""),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  }
}

function mergeProviderMetadata(
  parts: readonly Extract<SixbMessagePart, { type: "text" }>[]
): JsonValue | undefined {
  let merged: Record<string, JsonValue> | undefined
  for (const part of parts) {
    const meta = part.providerMetadata
    if (meta !== undefined && typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
      merged = { ...(merged ?? {}), ...meta }
    }
  }
  return merged
}

function userModelMessage(message: SixbMessage): SixbModelMessage {
  const content = message.parts.filter(isTextPart).map(
    (part): SixbModelTextPart => ({
      type: "text",
      text: part.text,
      ...(part.providerMetadata === undefined ? {} : { providerOptions: part.providerMetadata }),
    })
  )
  return { role: "user", content }
}

function appendAssistantModelMessages(result: SixbModelMessage[], message: SixbMessage): void {
  let block: SixbMessagePart[] = []
  const flush = (): void => {
    if (block.length === 0) {
      return
    }
    const current = block
    block = []

    const content: SixbModelAssistantPart[] = []
    for (const part of current) {
      if (part.type === "text") {
        content.push({
          type: "text",
          text: part.text,
          ...(part.providerMetadata === undefined
            ? {}
            : { providerOptions: part.providerMetadata }),
        })
      } else if (part.type === "reasoning") {
        content.push({
          type: "reasoning",
          text: part.text,
          ...(part.providerMetadata === undefined
            ? {}
            : { providerOptions: part.providerMetadata }),
        })
      } else if (part.type === "tool-call") {
        content.push(toolCallModelPart(part))
        if (part.providerExecuted === true) {
          content.push(toolResultModelPart(part, "json"))
        }
      }
    }
    result.push({ role: "assistant", content })

    const toolResults = current
      .filter(isToolCallPart)
      .filter((part) => part.providerExecuted !== true)
      .map((part) => toolResultModelPart(part, "text"))
    if (toolResults.length > 0) {
      result.push({ role: "tool", content: toolResults })
    }
  }

  for (const part of message.parts) {
    if (part.type === "step-start") {
      flush()
    } else {
      block.push(part)
    }
  }
  flush()
}

function toolCallModelPart(part: SixbToolCallPartResult): SixbModelToolCallPart {
  return {
    type: "tool-call",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input,
    ...(part.providerExecuted === undefined ? {} : { providerExecuted: part.providerExecuted }),
    ...(part.providerMetadata === undefined ? {} : { providerOptions: part.providerMetadata }),
  }
}

function toolResultModelPart(
  part: SixbToolCallPartResult,
  errorMode: "text" | "json"
): SixbModelToolResultPart {
  return {
    type: "tool-result",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    output: toolResultOutput(part, errorMode),
    ...(part.providerMetadata === undefined ? {} : { providerOptions: part.providerMetadata }),
  }
}

function toolResultOutput(
  part: SixbToolCallPartResult,
  errorMode: "text" | "json"
): SixbModelToolOutput {
  if (part.state === "output-error") {
    return errorMode === "json"
      ? { type: "error-json", value: part.errorText }
      : { type: "error-text", value: part.errorText }
  }
  return typeof part.output === "string"
    ? { type: "text", value: part.output }
    : { type: "json", value: part.output }
}

function isTextPart(part: SixbMessagePart): part is Extract<SixbMessagePart, { type: "text" }> {
  return part.type === "text"
}

function isToolCallPart(part: SixbMessagePart): part is SixbToolCallPartResult {
  return part.type === "tool-call"
}
