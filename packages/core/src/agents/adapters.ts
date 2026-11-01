import { isJsonValue, type JsonValue } from "../json"
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
import { agentMailInstruction } from "./agent-mail"
import { approvalOutcomeInstruction } from "./approval-outcome"
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

/** What the model reads for a {@link AgentContinuationPart}, in place of a user's words. */
export const AGENT_CONTINUATION_INSTRUCTION =
  "<sixb_continuation>Your previous answer stopped at the turn time limit. Continue from where it stopped, in the same language, without repeating what you already wrote.</sixb_continuation>"

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
   * Convert a user file reference into model-readable text context. This is appended before any
   * file data part so metadata, truncation notes, and sandbox/API access hints stay visible even for
   * models that cannot consume inline files.
   */
  readonly fileText?: (input: AgentFileDataResolverInput<TMessage>) => string | undefined
  /**
   * Framework text closing a user message, such as when it was sent. It must derive from stored
   * data only, so replaying the same history always projects the same bytes.
   */
  readonly userMessageSuffix?: (message: TMessage) => string | undefined
  /** Add current metadata, sandbox paths, and projection notes for a tool-result file. */
  readonly toolResultFileText?: (
    input: AgentToolResultFileResolverInput<TMessage>
  ) => string | undefined
  /**
   * Input that followed a step's tool results when it ran, such as the images those tools
   * returned, so a replay sends it again in the same place. `partIndex` is the step's first local
   * tool call.
   */
  readonly afterToolResults?: (input: {
    readonly message: TMessage
    readonly partIndex: number
  }) => ModelMessage | undefined
}

/**
 * Project durable messages into Sixb model messages. Assistant parts are grouped
 * into blocks at each `step-start`; each nonempty block yields one `assistant` message plus, for any
 * non-provider-executed tool calls, one `tool` message. Provider-executed tool results stay inline
 * in the assistant message. A call whose tool projected its output for the model replays the
 * stored `modelOutput`, the bytes the model read; otherwise a string output maps to `text` and
 * anything else to `json`. Assistant file attachments are not projected as assistant-authored text.
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
    if (part.type === "continuation") {
      content.push({ type: "text", text: AGENT_CONTINUATION_INSTRUCTION })
      return
    }
    if (part.type === "approval-outcome") {
      content.push({ type: "text", text: `${approvalOutcomeInstruction(part)}\n\n` })
      return
    }
    if (part.type === "mail") {
      content.push({ type: "text", text: agentMailInstruction(part) })
      return
    }
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
  const suffix = options.userMessageSuffix?.(message)
  if (suffix) content.push({ type: "text", text: `\n\n${suffix}` })
  return { role: "user", content }
}

/** One step of a stored assistant message: its parts between two `step-start`s. */
export interface AgentMessageStep {
  readonly parts: readonly { readonly part: AgentMessagePart; readonly partIndex: number }[]
  /**
   * The calls the runtime ran, not the provider, in order: one `tool` message replays their
   * results, and the first one's part index names that message.
   */
  readonly localToolCalls: readonly {
    readonly part: AgentToolCallPart
    readonly partIndex: number
  }[]
}

/** A stored assistant message's nonempty steps, as {@link toModelMessages} replays them. */
export function agentMessageSteps(message: Pick<AgentMessage, "parts">): AgentMessageStep[] {
  const steps: AgentMessageStep[] = []
  let parts: AgentMessageStep["parts"][number][] = []
  const flush = () => {
    if (parts.length === 0) return

    const localToolCalls = parts.flatMap(({ part, partIndex }) =>
      part.type === "tool-call" && part.providerExecuted !== true ? [{ part, partIndex }] : []
    )
    steps.push({ parts, localToolCalls })
    parts = []
  }

  message.parts.forEach((part, partIndex) => {
    if (part.type === "step-start") {
      flush()
    } else {
      parts.push({ part, partIndex })
    }
  })
  flush()
  return steps
}

function appendAssistantModelMessages<TMessage extends AgentMessage>(
  result: ModelMessage[],
  message: TMessage,
  options: ToModelMessagesOptions<TMessage>
): void {
  for (const step of agentMessageSteps(message)) {
    const content: ModelAssistantPart[] = []
    const toolResults: ModelToolResultPart[] = []
    for (const { part, partIndex } of step.parts) {
      if (part.type === "text" || part.type === "reasoning") {
        content.push({
          type: part.type,
          text: part.text,
          ...(part.providerMetadata === undefined ? {} : { providerData: part.providerMetadata }),
        })
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
    if (content.length > 0) result.push({ role: "assistant", content })

    const first = step.localToolCalls[0]
    if (toolResults.length > 0 && first) {
      result.push({ role: "tool", content: toolResults })

      const followUp = options.afterToolResults?.({ message, partIndex: first.partIndex })
      if (followUp) result.push(followUp)
    }
  }
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

  // What the model read when the tool ran: projecting `output` again would send other bytes.
  const modelOutput = storedModelOutput(part.modelOutput)
  if (modelOutput) return modelOutput

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

/** A stored model output in a shape the model loop accepts, or undefined to project `output`. */
function storedModelOutput(value: unknown): ModelToolOutput | undefined {
  if (typeof value !== "object" || value === null) return undefined

  const { type, value: content } = value as { readonly type?: unknown; readonly value?: unknown }
  if (type === "text" && typeof content === "string") return { type, value: content }
  if (type === "json" && isJsonValue(content)) return { type, value: content }
  return undefined
}

function toolResultFileFallbackText(part: AgentToolFileContent): string {
  const attributes = [
    part.fileRef.fileName ? `name=${JSON.stringify(part.fileRef.fileName)}` : undefined,
    part.fileRef.mediaType ? `mediaType=${JSON.stringify(part.fileRef.mediaType)}` : undefined,
    `sizeBytes=${part.fileRef.sizeBytes}`,
  ].filter((value): value is string => value !== undefined)
  return `[Tool-created file: ${attributes.join(" ")}. Contents are not available inline.]`
}
