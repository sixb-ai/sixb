import {
  assertJsonObject,
  type JsonObject,
  type LanguageModelStreamEvent,
  type ModelFinishReason,
  ModelProviderError,
  type ModelProviderIds,
  type ModelUsage,
  type ProviderData,
} from "@sixb/core/models"
import { integer, object, string } from "../json"
import { decodeServerSentEvents } from "../sse"
import { responsesUsage } from "./usage"

/** Provider policy stays outside the wire protocol: identity, usage semantics, and enrichment. */
export interface ResponsesStreamOptions {
  readonly providerId: string
  readonly modelId: string
  readonly requestId?: string
  readonly errorPrefix: string
  readonly providerIds?: (response: JsonObject | undefined, requestId?: string) => ModelProviderIds
  readonly usage?: (raw: JsonObject | undefined) => ModelUsage
  readonly finishMetadata?: (
    response: JsonObject
  ) => Pick<
    Extract<LanguageModelStreamEvent, { type: "finish" }>,
    "providerData" | "reportedCost" | "route"
  >
}

export async function* responsesEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  options: ResponsesStreamOptions
): AsyncIterable<LanguageModelStreamEvent> {
  const state = new ResponseState(options)
  for await (const event of decodeServerSentEvents(body, signal)) {
    if (event.data === "[DONE]") break
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
    assertJsonObject(value, `${options.errorPrefix} Responses SSE data`)
    for (const normalized of state.accept(event.event ?? string(value.type), value)) {
      yield normalized
    }
  }
  if (!state.finished) {
    throw new ModelProviderError(
      `${options.errorPrefix} Provider stream ended without a terminal response event.`,
      options.providerId,
      options.modelId,
      options.requestId === undefined ? undefined : { requestId: options.requestId }
    )
  }
}

class ResponseState {
  readonly items = new Map<string, JsonObject>()
  readonly toolArguments = new Map<string, string>()
  readonly toolEnded = new Set<string>()
  readonly textStarted = new Set<string>()
  readonly refusalSpans = new Map<string, { text: string; complete: boolean }>()
  readonly reasoningSpans = new Map<string, { itemId: string; text: string; complete: boolean }>()
  readonly reasoningItemsEnded = new Set<string>()
  started = false
  finished = false
  sawToolCall = false

  constructor(private readonly options: ResponsesStreamOptions) {}

  private get providerId(): string {
    return this.options.providerId
  }

  private providerIds(response: JsonObject | undefined): ModelProviderIds {
    const { requestId } = this.options
    if (this.options.providerIds) return this.options.providerIds(response, requestId)
    const id = string(response?.id)
    return { ...(requestId ? { requestId } : {}), ...(id ? { responseId: id } : {}) }
  }

  accept(eventName: string, value: JsonObject): readonly LanguageModelStreamEvent[] {
    const type = string(value.type) || eventName
    const events: LanguageModelStreamEvent[] = []
    const ensureStart = () => {
      if (!this.started) {
        this.started = true
        events.push({ type: "stream-start" })
      }
    }

    if (type === "response.created" || type === "response.in_progress") {
      ensureStart()
      const response = object(value.response)
      const id = string(response?.id)
      const modelId = string(response?.model)
      if (id || modelId) {
        events.push({
          type: "response-metadata",
          providerIds: this.providerIds(response),
          ...(id ? { id } : {}),
          ...(modelId ? { modelId } : {}),
        })
      }
      return events
    }

    ensureStart()
    if (type === "response.output_item.added") {
      const item = object(value.item)
      if (!item) return events
      const key = itemKey(value, item)
      this.items.set(key, item)
      if (item.type === "function_call") {
        const callId = string(item.call_id) || string(item.id) || key
        const name = string(item.name)
        if (!name) throw this.protocolError("Function call is missing a name.")
        this.toolArguments.set(callId, string(item.arguments))
        this.sawToolCall = true
        events.push({ type: "tool-input-start", id: callId, toolName: name })
      }
      return events
    }

    if (type === "response.content_part.added" || type === "response.content_part.done") {
      const part = object(value.part)
      if (part?.type === "reasoning_text") {
        events.push(
          ...this.reasoningEvents(
            value,
            "content",
            string(part.text),
            type.endsWith(".done") ? "done" : "snapshot"
          )
        )
      }
      if (type === "response.content_part.done") return events
      if (part?.type === "refusal") {
        events.push(...this.refusalEvents(value, string(part.refusal), false))
      }
      if (part?.type === "output_text") {
        const id = textSpanId(value)
        this.textStarted.add(id)
        events.push({ type: "text-start", id, providerData: this.textProviderData(value) })
      }
      return events
    }

    if (type === "response.refusal.delta" || type === "response.refusal.done") {
      const complete = type === "response.refusal.done"
      events.push(
        ...this.refusalEvents(value, string(complete ? value.refusal : value.delta), complete)
      )
      return events
    }

    if (type === "response.output_text.delta") {
      const id = textSpanId(value)
      if (!this.textStarted.has(id)) {
        this.textStarted.add(id)
        events.push({ type: "text-start", id, providerData: this.textProviderData(value) })
      }
      events.push({ type: "text-delta", id, delta: string(value.delta) })
      return events
    }

    if (type === "response.output_text.done") {
      const id = textSpanId(value)
      if (!this.textStarted.has(id)) {
        this.textStarted.add(id)
        events.push({ type: "text-start", id, providerData: this.textProviderData(value) })
        const text = string(value.text)
        if (text) events.push({ type: "text-delta", id, delta: text })
      }
      events.push({ type: "text-end", id })
      return events
    }

    if (
      type === "response.reasoning_summary_part.added" ||
      type === "response.reasoning_summary_part.done" ||
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_summary_text.done" ||
      type === "response.reasoning.delta" ||
      type === "response.reasoning.done" ||
      type === "response.reasoning_text.delta" ||
      type === "response.reasoning_text.done"
    ) {
      const delta = type.endsWith(".delta")
      events.push(
        ...this.reasoningEvents(
          value,
          type.startsWith("response.reasoning_summary_") ? "summary" : "content",
          string(delta ? value.delta : (value.text ?? object(value.part)?.text)),
          delta ? "delta" : type.endsWith(".done") ? "done" : "snapshot"
        )
      )
      return events
    }

    if (type === "response.function_call_arguments.delta") {
      const callId = toolCallId(value, this.items)
      const delta = string(value.delta)
      this.toolArguments.set(callId, (this.toolArguments.get(callId) ?? "") + delta)
      events.push({ type: "tool-input-delta", id: callId, delta })
      return events
    }

    if (type === "response.function_call_arguments.done") {
      const callId = toolCallId(value, this.items)
      const supplied = string(value.arguments)
      const previous = this.toolArguments.get(callId) ?? ""
      if (supplied) this.toolArguments.set(callId, supplied)
      const item = itemForEvent(value, this.items)
      const name = string(item?.name)
      if (!name) throw this.protocolError("Function call completion is missing a name.")
      this.toolEnded.add(callId)
      if (supplied && !previous) {
        events.push({ type: "tool-input-delta", id: callId, delta: supplied })
      }
      events.push({
        type: "tool-input-end",
        id: callId,
        providerData: providerItemData(this.providerId, {
          ...(item ?? {}),
          type: "function_call",
          call_id: callId,
          name,
          arguments: this.toolArguments.get(callId) ?? "",
        }),
      })
      return events
    }

    if (type === "response.output_item.done") {
      const item = object(value.item)
      if (!item) return events
      const key = itemKey(value, item)
      this.items.set(key, item)
      if (item.type === "reasoning") {
        events.push(...this.reasoningItemEvents(key, item))
        return events
      }
      if (item.type === "message" && typeof item.phase === "string") {
        // Phase can arrive after the text spans have closed. Keep message-level replay metadata
        // separately, without duplicating the full visible text in provider state.
        events.push({
          type: "provider-state",
          providerId: this.providerId,
          data: { messageId: key, phase: item.phase },
        })
      }
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const [contentIndex, content] of item.content.entries()) {
          const part = object(content)
          if (part?.type !== "refusal") continue
          events.push(
            ...this.refusalEvents(
              { ...value, item_id: key, content_index: contentIndex },
              string(part.refusal),
              true
            )
          )
        }
      }
      if (item.type !== "message" && item.type !== "function_call") {
        events.push({ type: "provider-state", providerId: this.providerId, data: { item } })
      }
      if (item.type === "function_call") {
        const callId = string(item.call_id) || string(item.id) || key
        const name = string(item.name)
        if (!name) throw this.protocolError("Function call completion is missing a name.")
        if (!this.toolEnded.has(callId)) {
          const argumentsText = string(item.arguments)
          const previous = this.toolArguments.get(callId) ?? ""
          if (argumentsText && !previous) {
            events.push({ type: "tool-input-delta", id: callId, delta: argumentsText })
          }
          this.toolEnded.add(callId)
          events.push({
            type: "tool-input-end",
            id: callId,
            providerData: providerItemData(this.providerId, { ...item, arguments: argumentsText }),
          })
        }
      }
      return events
    }

    if (type === "response.completed" || type === "response.incomplete") {
      const response = object(value.response) ?? value
      if (Array.isArray(response.output)) {
        for (const [outputIndex, output] of response.output.entries()) {
          const item = object(output)
          if (item?.type === "reasoning") {
            events.push(
              ...this.reasoningItemEvents(string(item.id) || `output:${outputIndex}`, item)
            )
          }
        }
      }
      events.push(...this.closeReasoningSpans())
      const status = string(response.status)
      const rawReason = incompleteReason(response) || status || type
      const usage = (this.options.usage ?? responsesUsage)(object(response.usage))
      events.push({ type: "response-metadata", providerIds: this.providerIds(response) })
      this.finished = true
      events.push({
        type: "finish",
        finishReason:
          this.refusalSpans.size > 0 ? "content-filter" : finishReason(response, this.sawToolCall),
        rawFinishReason: rawReason,
        usage,
        ...this.options.finishMetadata?.(response),
      })
      return events
    }

    if (type === "response.failed" || type === "error") {
      this.finished = true
      const response = object(value.response)
      const error =
        object(response?.error) ?? object(value.error) ?? (type === "error" ? value : undefined)
      events.push({
        type: "error",
        error: new ModelProviderError(
          string(error?.message) || `${this.options.errorPrefix} Provider response failed.`,
          this.providerId,
          this.options.modelId,
          {
            ...(string(error?.code) || string(error?.type)
              ? { code: string(error?.code) || string(error?.type) }
              : {}),
            ...(this.options.requestId === undefined ? {} : { requestId: this.options.requestId }),
          }
        ),
      })
      return events
    }
    return events
  }

  private protocolError(message: string): ModelProviderError {
    return new ModelProviderError(
      `${this.options.errorPrefix} ${message}`,
      this.providerId,
      this.options.modelId,
      this.options.requestId === undefined ? undefined : { requestId: this.options.requestId }
    )
  }

  /** Gateway uses reasoning.delta; native Responses streams use reasoning_text/summary_text. */
  private reasoningEvents(
    value: JsonObject,
    field: "content" | "summary",
    text: string,
    mode: "delta" | "snapshot" | "done"
  ): LanguageModelStreamEvent[] {
    const itemId = string(value.item_id) || `output:${integer(value.output_index) ?? 0}`
    const index = integer(value[`${field}_index`]) ?? 0
    const id = `${itemId}:${field === "summary" ? "reasoning" : "reasoning-text"}:${index}`
    const events: LanguageModelStreamEvent[] = []
    let span = this.reasoningSpans.get(id)
    if (!span) {
      span = { itemId, text: "", complete: false }
      this.reasoningSpans.set(id, span)
      events.push({ type: "reasoning-start", id })
    }
    if (span.complete) return events
    // Done/part/item snapshots repeat the full text; only append a missing suffix.
    const delta =
      mode === "delta" ? text : text.startsWith(span.text) ? text.slice(span.text.length) : ""
    if (delta) {
      span.text += delta
      events.push({ type: "reasoning-delta", id, delta })
    }
    if (mode === "done") {
      span.complete = true
      span.text = ""
      events.push({ type: "reasoning-end", id })
    }
    return events
  }

  private closeReasoningSpans(itemId?: string): LanguageModelStreamEvent[] {
    const events: LanguageModelStreamEvent[] = []
    for (const [id, span] of this.reasoningSpans) {
      if (!span.complete && (itemId === undefined || span.itemId === itemId)) {
        span.complete = true
        span.text = ""
        events.push({ type: "reasoning-end", id })
      }
    }
    return events
  }

  private reasoningItemEvents(key: string, item: JsonObject): LanguageModelStreamEvent[] {
    if (this.reasoningItemsEnded.has(key)) return []
    this.reasoningItemsEnded.add(key)
    const events: LanguageModelStreamEvent[] = []
    for (const field of ["content", "summary"] as const) {
      const parts = item[field]
      if (!Array.isArray(parts)) continue
      for (const [index, content] of parts.entries()) {
        const part = object(content)
        if (part?.type !== (field === "summary" ? "summary_text" : "reasoning_text")) continue
        events.push(
          ...this.reasoningEvents(
            { item_id: key, [`${field}_index`]: index },
            field,
            string(part.text),
            "done"
          )
        )
      }
    }
    events.push(...this.closeReasoningSpans(key))
    // Keep the native item (including encrypted content) for tool-loop/history replay.
    events.push({ type: "provider-state", providerId: this.providerId, data: { item } })
    return events
  }

  /** Completion events may repeat streamed refusals or provide their only visible text. */
  private refusalEvents(
    value: JsonObject,
    text: string,
    complete: boolean
  ): LanguageModelStreamEvent[] {
    const id = textSpanId(value)
    const events: LanguageModelStreamEvent[] = []
    let span = this.refusalSpans.get(id)
    if (!span) {
      span = { text: "", complete: false }
      this.refusalSpans.set(id, span)
      events.push({ type: "text-start", id, providerData: this.textProviderData(value) })
    }
    if (span.complete) return events
    const delta = complete && span.text ? "" : text
    if (delta) {
      span.text += delta
      events.push({ type: "text-delta", id, delta })
    }
    if (complete) {
      span.complete = true
      events.push({ type: "text-end", id })
    }
    return events
  }

  private textProviderData(value: JsonObject): ProviderData {
    return {
      [this.providerId]: {
        messageId: string(value.item_id) || `output:${integer(value.output_index) ?? 0}`,
      },
    }
  }
}

function providerItemData(providerId: string, item: JsonObject): ProviderData {
  return { [providerId]: { item } }
}

function finishReason(response: JsonObject, sawToolCall: boolean): ModelFinishReason {
  if (sawToolCall) return "tool-calls"
  const reason = incompleteReason(response)
  if (reason.includes("max_output") || reason.includes("length")) return "length"
  if (reason.includes("content_filter")) return "content-filter"
  if (string(response.status) === "failed") return "error"
  return string(response.status) === "completed" ? "stop" : "other"
}

function incompleteReason(response: JsonObject): string {
  return string(object(response.incomplete_details)?.reason)
}

function itemKey(event: JsonObject, item: JsonObject): string {
  return string(item.id) || `output:${integer(event.output_index) ?? 0}`
}

function itemForEvent(
  event: JsonObject,
  items: ReadonlyMap<string, JsonObject>
): JsonObject | undefined {
  const itemId = string(event.item_id)
  if (itemId && items.has(itemId)) return items.get(itemId)
  return items.get(`output:${integer(event.output_index) ?? 0}`)
}

function toolCallId(event: JsonObject, items: ReadonlyMap<string, JsonObject>): string {
  const item = itemForEvent(event, items)
  return string(event.call_id) || string(item?.call_id) || string(item?.id) || string(event.item_id)
}

function textSpanId(event: JsonObject): string {
  return `${string(event.item_id) || `output:${integer(event.output_index) ?? 0}`}:text:${integer(event.content_index) ?? 0}`
}
