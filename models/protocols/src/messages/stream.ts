import {
  assertJsonObject,
  isJsonObject,
  type JsonObject,
  type LanguageModelStreamEvent,
  type ModelFinishReason,
  ModelProviderError,
  type ModelUsage,
  type ProviderData,
} from "@sixb/core/models"
import { integer, object, string } from "../json"
import { decodeServerSentEvents } from "../sse"
import { messagesUsage } from "./usage"

export interface MessagesStreamOptions {
  readonly providerId: string
  readonly modelId: string
  readonly requestId?: string
  readonly errorPrefix: string
  /** Provider-specific counter semantics; defaults to Anthropic Messages accounting. */
  readonly usage?: (raw: JsonObject) => ModelUsage
}

export async function* messagesEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  options: MessagesStreamOptions
): AsyncIterable<LanguageModelStreamEvent> {
  const state = new MessageState(options)
  for await (const event of decodeServerSentEvents(body, signal)) {
    let value: unknown
    try {
      value = JSON.parse(event.data)
    } catch (error) {
      throw new ModelProviderError(
        `${options.errorPrefix} Provider emitted invalid SSE JSON.`,
        options.providerId,
        options.modelId,
        {
          cause: error,
          ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
        }
      )
    }
    assertJsonObject(value, `${options.errorPrefix} Messages SSE data`)
    for (const normalized of state.accept(event.event ?? string(value.type), value)) {
      yield normalized
    }
  }
  if (!state.finished) {
    throw new ModelProviderError(
      `${options.errorPrefix} Provider stream ended without a terminal message event.`,
      options.providerId,
      options.modelId,
      options.requestId === undefined ? undefined : { requestId: options.requestId }
    )
  }
}

interface ContentBlockState {
  readonly id: string
  readonly type: string
  readonly raw: JsonObject
  toolInput: string
}

class MessageState {
  private readonly blocks = new Map<number, ContentBlockState>()
  private usage: JsonObject = {}
  private stopReason = ""
  private started = false
  finished = false

  constructor(private readonly options: MessagesStreamOptions) {}

  private get providerId(): string {
    return this.options.providerId
  }

  accept(eventName: string, value: JsonObject): readonly LanguageModelStreamEvent[] {
    const type = string(value.type) || eventName
    if (type === "message_start") return this.startMessage(value)
    if (type === "ping") return []
    if (type === "error") {
      this.finished = true
      const error = object(value.error)
      return [
        {
          type: "error",
          error: new ModelProviderError(
            `${this.options.errorPrefix} ${string(error?.message) || "Provider response failed."}`,
            this.providerId,
            this.options.modelId,
            {
              ...(string(error?.type) ? { code: string(error?.type) } : {}),
              ...(this.options.requestId === undefined
                ? {}
                : { requestId: this.options.requestId }),
            }
          ),
        },
      ]
    }
    if (!this.started) throw this.protocolError(`Received '${type}' before message_start.`)
    if (type === "content_block_start") return this.startBlock(value)
    if (type === "content_block_delta") return this.deltaBlock(value)
    if (type === "content_block_stop") return this.stopBlock(value)
    if (type === "message_delta") {
      const delta = object(value.delta)
      this.stopReason = string(delta?.stop_reason) || this.stopReason
      this.usage = mergeJson(this.usage, object(value.usage))
      return []
    }
    if (type === "message_stop") {
      if (this.blocks.size > 0)
        throw this.protocolError("Message stopped with open content blocks.")
      this.finished = true
      return [
        {
          type: "finish",
          finishReason: finishReason(this.stopReason),
          ...(this.stopReason ? { rawFinishReason: this.stopReason } : {}),
          usage: (this.options.usage ?? messagesUsage)(this.usage),
        },
      ]
    }
    // The Messages API may add event types without a version bump. Ignore unknown events safely.
    return []
  }

  private startMessage(value: JsonObject): readonly LanguageModelStreamEvent[] {
    if (this.started) throw this.protocolError("Received duplicate message_start.")
    this.started = true
    const message = object(value.message)
    this.usage = mergeJson(this.usage, object(message?.usage))
    const id = string(message?.id)
    const modelId = string(message?.model)
    const { requestId } = this.options
    return [
      { type: "stream-start" },
      ...(id || modelId || requestId
        ? [
            {
              type: "response-metadata" as const,
              providerIds: {
                ...(id ? { responseId: id } : {}),
                ...(requestId ? { requestId } : {}),
              },
              ...(id ? { id } : {}),
              ...(modelId ? { modelId } : {}),
            },
          ]
        : []),
    ]
  }

  private startBlock(value: JsonObject): readonly LanguageModelStreamEvent[] {
    const index = this.requiredIndex(value.index, "content block")
    if (this.blocks.has(index)) throw this.protocolError(`Duplicate content block ${index}.`)
    const raw = object(value.content_block)
    const type = string(raw?.type)
    if (!raw || !type) throw this.protocolError(`Content block ${index} is missing its type.`)
    const id = `content:${index}`
    const block: ContentBlockState = {
      id,
      type,
      raw: { ...raw },
      toolInput: "",
    }
    this.blocks.set(index, block)
    if (type === "text") {
      const text = string(raw.text)
      return [
        { type: "text-start", id },
        ...(text ? [{ type: "text-delta" as const, id, delta: text }] : []),
      ]
    }
    if (type === "thinking") {
      const thinking = string(raw.thinking)
      return [
        { type: "reasoning-start", id },
        ...(thinking ? [{ type: "reasoning-delta" as const, id, delta: thinking }] : []),
      ]
    }
    if (type === "tool_use") {
      const callId = string(raw.id)
      const name = string(raw.name)
      if (!callId || !name) throw this.protocolError(`Tool block ${index} is missing id or name.`)
      return [{ type: "tool-input-start", id: callId, toolName: name }]
    }
    return []
  }

  private deltaBlock(value: JsonObject): readonly LanguageModelStreamEvent[] {
    const index = this.requiredIndex(value.index, "content block delta")
    const block = this.blocks.get(index)
    if (!block) throw this.protocolError(`Delta references unopened content block ${index}.`)
    const delta = object(value.delta)
    const type = string(delta?.type)
    if (type === "text_delta" && block.type === "text") {
      const text = string(delta?.text)
      block.raw.text = string(block.raw.text) + text
      return [{ type: "text-delta", id: block.id, delta: text }]
    }
    if (type === "thinking_delta" && block.type === "thinking") {
      const thinking = string(delta?.thinking)
      block.raw.thinking = string(block.raw.thinking) + thinking
      return [{ type: "reasoning-delta", id: block.id, delta: thinking }]
    }
    if (type === "signature_delta" && block.type === "thinking") {
      block.raw.signature = string(block.raw.signature) + string(delta?.signature)
      return []
    }
    if (type === "input_json_delta" && ["tool_use", "server_tool_use"].includes(block.type)) {
      const partial = string(delta?.partial_json)
      block.toolInput += partial
      return block.type === "tool_use"
        ? [{ type: "tool-input-delta", id: string(block.raw.id), delta: partial }]
        : []
    }
    if (type === "citations_delta" && block.type === "text") {
      const citation = delta?.citation
      if (citation !== undefined) {
        const citations = Array.isArray(block.raw.citations) ? block.raw.citations : []
        block.raw.citations = [...citations, citation]
      }
    }
    return []
  }

  private stopBlock(value: JsonObject): readonly LanguageModelStreamEvent[] {
    const index = this.requiredIndex(value.index, "content block stop")
    const block = this.blocks.get(index)
    if (!block) throw this.protocolError(`Stop references unopened content block ${index}.`)
    this.blocks.delete(index)
    if (block.type === "text") {
      return [
        { type: "text-end", id: block.id, providerData: blockData(this.providerId, block.raw) },
      ]
    }
    if (block.type === "thinking") {
      return [
        {
          type: "reasoning-end",
          id: block.id,
          providerData: blockData(this.providerId, block.raw),
        },
      ]
    }
    if (block.type === "tool_use") {
      const hadToolDelta = block.toolInput.length > 0
      if (!hadToolDelta) {
        block.toolInput = JSON.stringify(block.raw.input ?? {})
      }
      try {
        const input: unknown = JSON.parse(block.toolInput)
        if (isJsonObject(input)) block.raw.input = input
      } catch {
        // The core loop reports the malformed tool input with the original streamed text.
      }
      return [
        ...(hadToolDelta
          ? []
          : [
              {
                type: "tool-input-delta" as const,
                id: string(block.raw.id),
                delta: block.toolInput,
              },
            ]),
        {
          type: "tool-input-end",
          id: string(block.raw.id),
          providerData: blockData(this.providerId, block.raw),
        },
      ]
    }
    if (block.type === "server_tool_use" && block.toolInput) {
      try {
        const input: unknown = JSON.parse(block.toolInput)
        if (isJsonObject(input)) block.raw.input = input
      } catch {
        // Preserve the original block even if a future provider tool streams a different shape.
      }
    }
    return [{ type: "provider-state", providerId: this.providerId, data: { block: block.raw } }]
  }

  private protocolError(message: string): ModelProviderError {
    return new ModelProviderError(
      `${this.options.errorPrefix} ${message}`,
      this.providerId,
      this.options.modelId,
      this.options.requestId === undefined ? undefined : { requestId: this.options.requestId }
    )
  }

  private requiredIndex(value: unknown, label: string): number {
    const index = integer(value)
    if (index === undefined)
      throw new TypeError(`${this.options.errorPrefix} ${label} index is invalid.`)
    return index
  }
}

function blockData(providerId: string, block: JsonObject): ProviderData {
  return { [providerId]: { block } }
}

function finishReason(reason: string): ModelFinishReason {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop"
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "length"
  if (reason === "tool_use") return "tool-calls"
  if (reason === "pause_turn") return "pause"
  if (reason === "refusal") return "content-filter"
  return reason ? "other" : "unknown"
}

function mergeJson(previous: JsonObject, next: JsonObject | undefined): JsonObject {
  if (!next) return previous
  const merged: JsonObject = { ...previous }
  for (const [key, value] of Object.entries(next)) {
    if (value === null) continue
    const priorObject = object(merged[key])
    const nextObject = object(value)
    merged[key] = priorObject && nextObject ? mergeJson(priorObject, nextObject) : value
  }
  return merged
}
