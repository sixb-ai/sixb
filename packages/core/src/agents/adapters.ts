import type { JsonValue } from "../json"
import type {
  ModelAssistantPart,
  ModelFilePart,
  ModelMessage,
  ModelTextPart,
  ModelToolCallPart,
  ModelToolOutput,
  ModelToolResultPart,
  ProviderData,
} from "../models"
import { serializeAgentContextForModel } from "./context-model"
import type {
  AgentFilePart,
  AgentMessage,
  AgentMessagePart,
  AgentTextPart,
  AgentToolCallPart,
} from "./message"
import { isAgentToolResult } from "./tool-result"
import type { AgentToolFileContent } from "./types"

export interface AgentFileDataResolverInput<TMessage extends AgentMessage = AgentMessage> {
  readonly message: TMessage
  readonly part: AgentFilePart
  readonly partIndex: number
}

export interface AgentFileDataProjection {
  readonly data: URL
  readonly mediaType?: string
  readonly filename?: string
}

export interface AgentToolResultFileResolverInput<TMessage extends AgentMessage = AgentMessage> {
  readonly message: TMessage
  readonly part: AgentToolCallPart
  readonly partIndex: number
  readonly contentPart: AgentToolFileContent
  readonly contentIndex: number
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
  /** Add current metadata, sandbox paths, and projection notes for a tool-result file. */
  readonly toolResultFileText?: (
    input: AgentToolResultFileResolverInput<TMessage>
  ) => string | undefined
}

/**
 * Project durable messages into Sixb model messages. Assistant parts are grouped
 * into blocks at each `step-start`; each block yields one `assistant` message plus, for any
 * non-provider-executed tool calls, one `tool` message. Provider-executed tool results stay inline
 * in the assistant message. Without a tool registry, a string output maps to `text` and anything
 * else to `json`; this is the documented fidelity scope (a tool's custom `toModelOutput` is not
 * reproduced).
 */
export function toModelMessages<TMessage extends AgentMessage>(
  messages: readonly TMessage[],
  options: ToModelMessagesOptions<TMessage> = {}
): ModelMessage[] {
  const result: ModelMessage[] = []
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

function systemModelMessage(message: AgentMessage): ModelMessage {
  const textParts = message.parts.filter((part) => part.type === "text")
  const providerData = mergeProviderMetadata(textParts)
  return {
    role: "system",
    content: textParts.map((part) => part.text).join(""),
    ...(providerData === undefined ? {} : { providerData }),
  }
}

function mergeProviderMetadata(parts: readonly AgentTextPart[]): ProviderData | undefined {
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
): ModelMessage {
  const content: (ModelTextPart | ModelFilePart)[] = []
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
        ...(part.providerMetadata === undefined ? {} : { providerData: part.providerMetadata }),
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
          ...(part.providerMetadata === undefined ? {} : { providerData: part.providerMetadata }),
        })
      }
    }
  })
  return { role: "user", content }
}

function appendAssistantModelMessages<TMessage extends AgentMessage>(
  result: ModelMessage[],
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

    const content: ModelAssistantPart[] = []
    const toolResults: ModelToolResultPart[] = []
    for (const { part, partIndex } of current) {
      if (part.type === "text" || part.type === "reasoning") {
        content.push({
          type: part.type,
          text: part.text,
          ...(part.providerMetadata === undefined ? {} : { providerData: part.providerMetadata }),
        })
      } else if (part.type === "file") {
        const fileContext = options.fileText?.({ message, part, partIndex })
        if (fileContext) {
          content.push({ type: "text", text: fileContext })
        }
      } else if (part.type === "tool-call") {
        content.push(toolCallModelPart(part))
        if (part.providerExecuted === true) {
          content.push(toolResultModelPart(message, part, partIndex, "json", options))
        } else {
          toolResults.push(toolResultModelPart(message, part, partIndex, "text", options))
        }
      } else if (part.type === "provider-state") {
        content.push({
          type: "provider-state",
          providerId: part.providerId,
          data: part.data,
        })
      }
    }
    result.push({ role: "assistant", content })

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

function toolCallModelPart(part: AgentToolCallPart): ModelToolCallPart {
  return {
    type: "tool-call",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input,
    ...(part.providerExecuted === undefined ? {} : { providerExecuted: part.providerExecuted }),
    ...(part.providerMetadata === undefined ? {} : { providerData: part.providerMetadata }),
  }
}

function toolResultModelPart<TMessage extends AgentMessage>(
  message: TMessage,
  part: AgentToolCallPart,
  partIndex: number,
  errorMode: "text" | "json",
  options: ToModelMessagesOptions<TMessage>
): ModelToolResultPart {
  // Stored providerMetadata belongs to the call, not this synthesized result. Replaying it here
  // can replace the result with the provider's original tool-call block.
  return {
    type: "tool-result",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    output: toolResultOutput(message, part, partIndex, errorMode, options),
  }
}

function toolResultOutput<TMessage extends AgentMessage>(
  message: TMessage,
  part: AgentToolCallPart,
  partIndex: number,
  errorMode: "text" | "json",
  options: ToModelMessagesOptions<TMessage>
): ModelToolOutput {
  if (part.state === "output-error") {
    return errorMode === "json"
      ? { type: "error-json", value: part.errorText }
      : { type: "error-text", value: part.errorText }
  }
  if (isAgentToolResult(part.output)) {
    const value: string[] = []
    part.output.content.forEach((contentPart, contentIndex) => {
      if (contentPart.type === "text") {
        value.push(contentPart.text)
        return
      }

      const fileContext = options.toolResultFileText?.({
        message,
        part,
        partIndex,
        contentPart,
        contentIndex,
      })
      value.push(fileContext ?? toolResultFileFallbackText(contentPart))
    })
    return { type: "text", value: value.join("\n") }
  }
  return typeof part.output === "string"
    ? { type: "text", value: part.output }
    : { type: "json", value: part.output }
}

function toolResultFileFallbackText(part: AgentToolFileContent): string {
  const attributes = [
    part.fileRef.fileName ? `name=${JSON.stringify(part.fileRef.fileName)}` : undefined,
    part.fileRef.mediaType ? `mediaType=${JSON.stringify(part.fileRef.mediaType)}` : undefined,
    `sizeBytes=${part.fileRef.sizeBytes}`,
  ].filter((value): value is string => value !== undefined)
  return `[Tool-created file: ${attributes.join(" ")}. Contents are not available inline.]`
}
