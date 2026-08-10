import { type FileRef, isFileRef } from "../blob-storage"
import { getInvalidJsonValueReason, isPlainRecord, type JsonValue } from "../json"
import {
  type AgentContextEntryInput,
  type AgentContextInput,
  type AgentContextOrigin,
  normalizeAgentContextEntries,
} from "./context"
import { serializeAgentContextForModel } from "./context-model"
import { AgentMessageAdapterError } from "./errors"
import type { AgentMessage, AgentMessagePart, AgentMessageRole } from "./message"

// ── Inbound (write) — deliberately WIDE ────────────────────────────────────────────────────────
//
// `fromAiSdk` is the safety net at the SDK boundary, so its input is intentionally permissive: any
// `{ type: string }` part is accepted at the type level and narrowed at runtime. This is a
// structural supertype of the AI SDK's `UIMessage`, so a real SDK message can be passed without a
// cast (verified by a compat test in the consumer package, where `ai` lives — core stays SDK-free).

export interface AgentInboundUiMessagePart {
  readonly type: string
  readonly text?: string
  readonly state?: string
  // Provider metadata stays `unknown` here, exactly like `input` / `output` / `rawInput`: the SDK
  // types it as provider metadata (a nested record), which is not structurally a Sixb
  // `JsonValue`, so constraining it would break the "real SDK message assigns without a cast"
  // contract (locked by the consumer's compat test). `fromAiSdk` validates it to JSON at runtime.
  readonly providerMetadata?: unknown
  readonly toolName?: string
  readonly toolCallId?: string
  readonly providerExecuted?: boolean
  readonly input?: unknown
  readonly rawInput?: unknown
  readonly output?: unknown
  readonly errorText?: string
  readonly callProviderMetadata?: unknown
  readonly fileRef?: unknown
  readonly context?: unknown
  readonly origin?: unknown
}

export interface AgentInboundUiMessage {
  readonly role: string
  readonly id?: string
  readonly metadata?: unknown
  readonly parts: readonly AgentInboundUiMessagePart[]
}

// ── Outbound (read) — PRECISE, aligned with the AI SDK message surface ──────────────────────────

interface AgentUiToolPartBody {
  readonly toolCallId: string
  readonly providerExecuted?: boolean
  readonly callProviderMetadata?: JsonValue
}

export type AgentUiToolPart =
  | ({ readonly type: `tool-${string}` } & AgentUiToolPartBody &
      (
        | {
            readonly state: "output-available"
            readonly input: JsonValue
            readonly output: JsonValue
          }
        | { readonly state: "output-error"; readonly input: JsonValue; readonly errorText: string }
      ))
  | ({ readonly type: "dynamic-tool"; readonly toolName: string } & AgentUiToolPartBody &
      (
        | {
            readonly state: "output-available"
            readonly input: JsonValue
            readonly output: JsonValue
          }
        | { readonly state: "output-error"; readonly input: JsonValue; readonly errorText: string }
      ))

export type AgentUiMessagePart =
  | { readonly type: "text"; readonly text: string; readonly providerMetadata?: JsonValue }
  | { readonly type: "reasoning"; readonly text: string; readonly providerMetadata?: JsonValue }
  | { readonly type: "step-start" }
  | { readonly type: "file"; readonly fileRef: FileRef; readonly providerMetadata?: JsonValue }
  | {
      readonly type: "context"
      readonly context: AgentContextInput
      readonly origin: AgentContextOrigin
    }
  | AgentUiToolPart

export interface AgentUiMessage {
  readonly role: AgentMessageRole
  readonly id?: string
  readonly metadata?: JsonValue
  readonly parts: readonly AgentUiMessagePart[]
}

export type AgentModelToolOutput =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "json"; readonly value: JsonValue }
  | { readonly type: "error-text"; readonly value: string }
  | { readonly type: "error-json"; readonly value: JsonValue }

export interface AgentModelTextPart {
  readonly type: "text"
  readonly text: string
  readonly providerOptions?: JsonValue
}
export interface AgentModelFilePart {
  readonly type: "file"
  readonly data: URL
  readonly filename?: string
  readonly mediaType: string
  readonly providerOptions?: JsonValue
}
export interface AgentModelReasoningPart {
  readonly type: "reasoning"
  readonly text: string
  readonly providerOptions?: JsonValue
}
export interface AgentModelToolCallPart {
  readonly type: "tool-call"
  readonly toolCallId: string
  readonly toolName: string
  readonly input: JsonValue
  readonly providerExecuted?: boolean
  readonly providerOptions?: JsonValue
}
export interface AgentModelToolResultPart {
  readonly type: "tool-result"
  readonly toolCallId: string
  readonly toolName: string
  readonly output: AgentModelToolOutput
  readonly providerOptions?: JsonValue
}

export type AgentModelAssistantPart =
  | AgentModelTextPart
  | AgentModelReasoningPart
  | AgentModelToolCallPart
  | AgentModelToolResultPart

export type AgentModelMessage =
  | { readonly role: "system"; readonly content: string; readonly providerOptions?: JsonValue }
  | {
      readonly role: "user"
      readonly content: readonly (AgentModelTextPart | AgentModelFilePart)[]
    }
  | { readonly role: "assistant"; readonly content: readonly AgentModelAssistantPart[] }
  | { readonly role: "tool"; readonly content: readonly AgentModelToolResultPart[] }

export interface AgentFileDataResolverInput<TMessage extends AgentMessage = AgentMessage> {
  readonly message: TMessage
  readonly part: Extract<AgentMessagePart, { type: "file" }>
  readonly partIndex: number
}

export interface AgentFileDataProjection {
  readonly data: URL
  readonly mediaType?: string
  readonly filename?: string
}

export interface ToModelMessagesOptions<TMessage extends AgentMessage = AgentMessage> {
  /**
   * Convert a stored file reference into model-readable data. When omitted, file parts are skipped
   * rather than leaking blob ids or passing an unsupported Sixb-only shape to model providers.
   */
  readonly fileData?:
    | ((input: AgentFileDataResolverInput<TMessage>) => URL | AgentFileDataProjection | undefined)
    | undefined
  /**
   * Convert a stored file reference into model-readable text context. This is appended before any
   * file data part so metadata, truncation notes, and sandbox/API access hints stay visible even for
   * models that cannot consume inline files.
   */
  readonly fileText?: (input: AgentFileDataResolverInput<TMessage>) => string | undefined
}

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
  if (value === undefined) return undefined
  return requireJson(omitUndefinedObjectProperties(value), label)
}

/**
 * Provider metadata is opaque SDK-owned data that can contain optional object keys with
 * `undefined` values. `undefined` is not JSON, but on an object property it means the same thing as
 * "field absent", so omit those properties before validating/persisting the metadata.
 *
 * Keep the scope deliberately narrow: arrays, tool inputs/outputs, Dates, functions, bigint, cycles,
 * and every other non-JSON shape are left for `requireJson` to accept or reject. This helper only
 * turns `{ key: undefined }` into `{}` for metadata compatibility with SDK output.
 */
export function omitUndefinedObjectProperties(value: unknown): unknown {
  return omitUndefinedObjectPropertiesInternal(value, new Set())
}

function omitUndefinedObjectPropertiesInternal(value: unknown, seen: Set<object>): unknown {
  if (typeof value !== "object" || value === null) return value

  // Avoid recursing forever on a malformed/cyclic metadata object. Leaving the cycle in place lets
  // `requireJson` below report the canonical JSON-contract error.
  if (seen.has(value)) return value

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => omitUndefinedObjectPropertiesInternal(entry, seen))
    }

    if (!isPlainRecord(value)) return value

    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, omitUndefinedObjectPropertiesInternal(entry, seen)])
    )
  } finally {
    seen.delete(value)
  }
}

function isToolType(type: string): boolean {
  return type === "dynamic-tool" || type.startsWith(TOOL_TYPE_PREFIX)
}

function toolNameFromInbound(part: AgentInboundUiMessagePart): string {
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
 * Convert an SDK-shaped UI message into a durable {@link AgentMessage}. Total: throws
 * {@link AgentMessageAdapterError} on any part kind, tool state, or text/reasoning state that V1 does
 * not model, and on a role outside `system | user | assistant`. Transient states are rejected
 * because messages are only ever persisted once a run has finished.
 */
export function fromAiSdk(message: AgentInboundUiMessage): AgentMessage {
  const { role } = message
  assertAdapter(
    role === "system" || role === "user" || role === "assistant",
    `unsupported message role '${role}'`
  )

  const parts: AgentMessagePart[] = message.parts.map((part) => fromAiSdkPart(part))
  assertAdapter(
    role === "user" || !parts.some((part) => part.type === "context"),
    "context parts are only valid on user messages"
  )
  const metadata = optionalJson(message.metadata, "metadata")

  return {
    role,
    parts,
    ...(metadata === undefined ? {} : { metadata }),
  }
}

function fromAiSdkPart(part: AgentInboundUiMessagePart): AgentMessagePart {
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
    case "file": {
      assertAdapter(isFileRef(part.fileRef), "file part is missing a valid fileRef")
      const providerMetadata = optionalJson(part.providerMetadata, "file.providerMetadata")
      return {
        type: "file",
        fileRef: part.fileRef,
        ...(providerMetadata === undefined ? {} : { providerMetadata }),
      }
    }
    case "context":
      return fromUiContextPart(part)
    default: {
      assertAdapter(
        isToolType(part.type),
        `unsupported message part type '${part.type}'; extend the Sixb message part union to support it`
      )
      return fromAiSdkToolPart(part)
    }
  }
}

function fromUiContextPart(part: AgentInboundUiMessagePart): AgentMessagePart {
  try {
    const [entry] = normalizeAgentContextEntries([
      { context: part.context, origin: part.origin } as AgentContextEntryInput,
    ])
    return { type: "context", ...entry }
  } catch (error) {
    throw new AgentMessageAdapterError(
      error instanceof Error ? error.message : "[Sixb] Invalid agent context part."
    )
  }
}

function fromAiSdkToolPart(part: AgentInboundUiMessagePart): AgentToolCallPartResult {
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

type AgentToolCallPartResult = Extract<AgentMessagePart, { type: "tool-call" }>

// ── toUiMessage (read) ────────────────────────────────────────────────────────────────────────

/** Reconstruct an SDK-shaped UI message from a stored message. Exact inverse of {@link fromAiSdk}. */
export function toUiMessage(message: AgentMessage): AgentUiMessage {
  return {
    role: message.role,
    parts: message.parts.map((part) => toUiPart(part)),
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
  }
}

function toUiPart(part: AgentMessagePart): AgentUiMessagePart {
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
    case "file":
      return {
        type: "file",
        fileRef: part.fileRef,
        ...(part.providerMetadata === undefined ? {} : { providerMetadata: part.providerMetadata }),
      }
    case "context":
      return { type: "context", context: part.context, origin: part.origin }
    case "tool-call":
      return toUiToolPart(part)
  }
}

function toUiToolPart(part: AgentToolCallPartResult): AgentUiToolPart {
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
 * Project messages into AI SDK `ModelMessage`s for replay into a model. The assistant/tool split
 * is hand-rolled to mirror `convertToModelMessages` (no `ai` import): assistant parts are grouped
 * into blocks at each `step-start`; each block yields one `assistant` message plus, for any
 * non-provider-executed tool calls, one `tool` message. Provider-executed tool results stay inline
 * in the assistant message. Without a tool registry, a string output maps to `text` and anything
 * else to `json`; this is the documented V1 fidelity scope (a tool's custom `toModelOutput` is not
 * reproduced).
 */
export function toModelMessages<TMessage extends AgentMessage>(
  messages: readonly TMessage[],
  options: ToModelMessagesOptions<TMessage> = {}
): AgentModelMessage[] {
  const result: AgentModelMessage[] = []
  for (const message of messages) {
    switch (message.role) {
      case "system":
        result.push(systemModelMessage(message))
        break
      case "user":
        result.push(userModelMessage(message, options))
        break
      case "assistant":
        appendAssistantModelMessages(result, message, options)
        break
    }
  }
  return result
}

function systemModelMessage(message: AgentMessage): AgentModelMessage {
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
  parts: readonly Extract<AgentMessagePart, { type: "text" }>[]
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

function userModelMessage<TMessage extends AgentMessage>(
  message: TMessage,
  options: ToModelMessagesOptions<TMessage>
): AgentModelMessage {
  const content: (AgentModelTextPart | AgentModelFilePart)[] = []
  const serializedContext = serializeAgentContextForModel(
    message.parts.filter((part) => part.type === "context")
  )
  if (serializedContext) {
    content.push({ type: "text", text: `${serializedContext}\n\n` })
  }
  message.parts.forEach((part, partIndex) => {
    if (part.type === "text") {
      content.push({
        type: "text",
        text: part.text,
        ...(part.providerMetadata === undefined ? {} : { providerOptions: part.providerMetadata }),
      })
      return
    }
    if (part.type === "file") {
      const fileContext = options.fileText?.({ message, part, partIndex })
      if (fileContext) {
        content.push({ type: "text", text: fileContext })
      }
      const resolved = options.fileData?.({ message, part, partIndex })
      if (resolved) {
        const projection = resolved instanceof URL ? { data: resolved } : resolved
        content.push({
          type: "file",
          data: projection.data,
          mediaType: projection.mediaType ?? part.fileRef.mediaType ?? "application/octet-stream",
          ...(projection.filename !== undefined
            ? { filename: projection.filename }
            : part.fileRef.fileName === undefined
              ? {}
              : { filename: part.fileRef.fileName }),
          ...(part.providerMetadata === undefined
            ? {}
            : { providerOptions: part.providerMetadata }),
        })
      }
    }
  })
  return { role: "user", content }
}

function appendAssistantModelMessages<TMessage extends AgentMessage>(
  result: AgentModelMessage[],
  message: TMessage,
  options: ToModelMessagesOptions<TMessage>
): void {
  let block: Array<{ readonly part: AgentMessagePart; readonly partIndex: number }> = []
  const flush = (): void => {
    if (block.length === 0) {
      return
    }
    const current = block
    block = []

    const content: AgentModelAssistantPart[] = []
    for (const { part, partIndex } of current) {
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
      } else if (part.type === "file") {
        const fileContext = options.fileText?.({ message, part, partIndex })
        if (fileContext) {
          content.push({ type: "text", text: fileContext })
        }
      } else if (part.type === "tool-call") {
        content.push(toolCallModelPart(part))
        if (part.providerExecuted === true) {
          content.push(toolResultModelPart(part, "json"))
        }
      }
    }
    result.push({ role: "assistant", content })

    const toolResults = current
      .map(({ part }) => part)
      .filter(isToolCallPart)
      .filter((part) => part.providerExecuted !== true)
      .map((part) => toolResultModelPart(part, "text"))
    if (toolResults.length > 0) {
      result.push({ role: "tool", content: toolResults })
    }
  }

  message.parts.forEach((part, partIndex) => {
    if (part.type === "step-start") {
      flush()
    } else {
      block.push({ part, partIndex })
    }
  })
  flush()
}

function toolCallModelPart(part: AgentToolCallPartResult): AgentModelToolCallPart {
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
  part: AgentToolCallPartResult,
  errorMode: "text" | "json"
): AgentModelToolResultPart {
  return {
    type: "tool-result",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    output: toolResultOutput(part, errorMode),
    ...(part.providerMetadata === undefined ? {} : { providerOptions: part.providerMetadata }),
  }
}

function toolResultOutput(
  part: AgentToolCallPartResult,
  errorMode: "text" | "json"
): AgentModelToolOutput {
  if (part.state === "output-error") {
    return errorMode === "json"
      ? { type: "error-json", value: part.errorText }
      : { type: "error-text", value: part.errorText }
  }
  return typeof part.output === "string"
    ? { type: "text", value: part.output }
    : { type: "json", value: part.output }
}

function isTextPart(part: AgentMessagePart): part is Extract<AgentMessagePart, { type: "text" }> {
  return part.type === "text"
}

function isToolCallPart(part: AgentMessagePart): part is AgentToolCallPartResult {
  return part.type === "tool-call"
}
