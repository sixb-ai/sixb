import {
  assertJsonObject,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type LanguageModel,
  type LanguageModelRequest,
  type LanguageModelStreamEvent,
  type ModelCapabilities,
  type ModelFinishReason,
  type ModelMessage,
  ModelProviderError,
  type ModelToolOutput,
  type ModelUsage,
  type ProviderData,
} from "@sixb/llm"
import { decodeServerSentEvents } from "./sse"

type ValueSource<T> = T | (() => T)

export interface OpenResponsesProviderOptions {
  readonly id: string
  readonly baseUrl: string
  readonly apiKey?: ValueSource<string | undefined>
  readonly headers?: ValueSource<Readonly<Record<string, string>>>
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

export interface OpenResponsesModelOptions {
  readonly request?: JsonObject
  /** Provider-native tools such as web search. Local Sixb tools are appended as functions. */
  readonly providerTools?: readonly JsonObject[]
  readonly capabilities?: ModelCapabilities
}

export interface OpenResponsesProvider {
  readonly id: string
  model(modelId: string, options?: OpenResponsesModelOptions): LanguageModel
}

export function createOpenResponsesProvider(
  options: OpenResponsesProviderOptions
): OpenResponsesProvider {
  if (!options.id.trim()) throw new TypeError("[SixbOpenResponses] Provider id must not be empty.")
  const baseUrl = options.baseUrl.replace(/\/+$/, "")
  if (!URL.canParse(baseUrl)) {
    throw new TypeError(`[SixbOpenResponses] Invalid base URL '${options.baseUrl}'.`)
  }
  return {
    id: options.id,
    model(modelId, modelOptions = {}) {
      if (!modelId.trim()) {
        throw new TypeError("[SixbOpenResponses] Model id must not be empty.")
      }
      return new OpenResponsesLanguageModel(options, baseUrl, modelId, modelOptions)
    },
  }
}

export function vercelGateway(
  options: Omit<OpenResponsesProviderOptions, "id" | "baseUrl"> = {}
): OpenResponsesProvider {
  return createOpenResponsesProvider({
    id: "vercel-gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    ...options,
    apiKey: options.apiKey ?? (() => process.env.AI_GATEWAY_API_KEY),
  })
}

class OpenResponsesLanguageModel implements LanguageModel {
  readonly providerId: string
  readonly modelId: string
  readonly capabilities: ModelCapabilities

  constructor(
    private readonly providerOptions: OpenResponsesProviderOptions,
    private readonly baseUrl: string,
    modelId: string,
    private readonly options: OpenResponsesModelOptions
  ) {
    this.providerId = providerOptions.id
    this.modelId = modelId
    if (options.request !== undefined) {
      assertJsonObject(options.request, "model request options")
    }
    for (const [index, tool] of (options.providerTools ?? []).entries()) {
      assertJsonObject(tool, `providerTools[${index}]`)
    }
    this.capabilities = options.capabilities ?? {
      inputMediaTypes: ["image/*", "application/pdf", "text/*"],
      reasoning: true,
      localTools: true,
      parallelToolCalls: true,
      nativeStructuredOutput: true,
      providerExecutedTools: true,
    }
  }

  async stream(request: LanguageModelRequest) {
    const response = await (this.providerOptions.fetch ?? fetch)(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(request)),
      signal: request.signal,
    })
    if (!response.ok) {
      throw await providerHttpError(response, this.providerId, this.modelId)
    }
    if (!response.body) {
      throw new ModelProviderError(
        "[SixbOpenResponses] Provider returned an empty streaming response.",
        this.providerId,
        this.modelId,
        { status: response.status }
      )
    }
    return { events: this.responseEvents(response.body, request.signal) }
  }

  private headers(): Record<string, string> {
    const headers = resolve(this.providerOptions.headers) ?? {}
    const apiKey = resolve(this.providerOptions.apiKey)
    return {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...headers,
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    }
  }

  private requestBody(request: LanguageModelRequest): JsonObject {
    const extra = this.options.request ?? {}
    for (const reserved of ["model", "input", "tools", "stream", "reasoning", "text"]) {
      if (Object.hasOwn(extra, reserved)) {
        throw new TypeError(
          `[SixbOpenResponses] Model request option '${reserved}' is owned by the adapter.`
        )
      }
    }
    const tools: JsonObject[] = [
      ...(this.options.providerTools ?? []),
      ...request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: true,
      })),
    ]
    return {
      ...extra,
      model: this.modelId,
      input: messagesToInput(request.messages, this.providerId),
      stream: true,
      ...(tools.length === 0
        ? {}
        : {
            tools,
            tool_choice: "auto",
            parallel_tool_calls: true,
          }),
      ...(request.reasoning === undefined || request.reasoning === "provider-default"
        ? {}
        : { reasoning: { effort: request.reasoning } }),
      ...(request.responseFormat === undefined
        ? {}
        : {
            text: {
              format: {
                type: "json_schema",
                name: request.responseFormat.name,
                ...(request.responseFormat.description === undefined
                  ? {}
                  : { description: request.responseFormat.description }),
                schema: request.responseFormat.schema,
                strict: true,
              },
            },
          }),
    }
  }

  private async *responseEvents(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal
  ): AsyncIterable<LanguageModelStreamEvent> {
    const state = new ResponseState(this.providerId, this.modelId)
    for await (const event of decodeServerSentEvents(body, signal)) {
      if (event.data === "[DONE]") break
      let value: unknown
      try {
        value = JSON.parse(event.data)
      } catch (error) {
        throw new ModelProviderError(
          "[SixbOpenResponses] Provider emitted invalid SSE JSON.",
          this.providerId,
          this.modelId,
          { cause: error }
        )
      }
      assertJsonObject(value, "OpenResponses SSE data")
      for (const normalized of state.accept(event.event ?? string(value.type), value)) {
        yield normalized
      }
    }
    if (!state.finished) {
      throw new ModelProviderError(
        "[SixbOpenResponses] Provider stream ended without a terminal response event.",
        this.providerId,
        this.modelId
      )
    }
  }
}

class ResponseState {
  readonly items = new Map<string, JsonObject>()
  readonly toolArguments = new Map<string, string>()
  readonly toolEnded = new Set<string>()
  readonly textStarted = new Set<string>()
  readonly reasoningStarted = new Set<string>()
  started = false
  finished = false
  sawToolCall = false
  constructor(
    private readonly providerId: string,
    private readonly modelId: string
  ) {}

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
        this.sawToolCall = true
        const callId = string(item.call_id) || string(item.id) || key
        const name = string(item.name)
        if (!name) throw this.protocolError("Function call is missing a name.")
        this.toolArguments.set(callId, string(item.arguments))
        events.push({ type: "tool-input-start", id: callId, toolName: name })
      }
      return events
    }

    if (type === "response.content_part.added") {
      const part = object(value.part)
      if (part?.type === "output_text") {
        const id = textSpanId(value)
        this.textStarted.add(id)
        events.push({ type: "text-start", id })
      }
      return events
    }

    if (type === "response.output_text.delta") {
      const id = textSpanId(value)
      if (!this.textStarted.has(id)) {
        this.textStarted.add(id)
        events.push({ type: "text-start", id })
      }
      events.push({ type: "text-delta", id, delta: string(value.delta) })
      return events
    }

    if (type === "response.output_text.done") {
      const id = textSpanId(value)
      if (!this.textStarted.has(id)) {
        this.textStarted.add(id)
        events.push({ type: "text-start", id })
        const text = string(value.text)
        if (text) events.push({ type: "text-delta", id, delta: text })
      }
      events.push({ type: "text-end", id })
      return events
    }

    if (
      type === "response.reasoning_summary_part.added" ||
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_summary_text.done"
    ) {
      const id = reasoningSpanId(value)
      if (!this.reasoningStarted.has(id)) {
        this.reasoningStarted.add(id)
        events.push({ type: "reasoning-start", id })
      }
      if (type === "response.reasoning_summary_text.delta") {
        events.push({ type: "reasoning-delta", id, delta: string(value.delta) })
      }
      if (type === "response.reasoning_summary_text.done") {
        events.push({ type: "reasoning-end", id })
      }
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
      if (supplied) this.toolArguments.set(callId, supplied)
      const item = itemForEvent(value, this.items)
      const name = string(item?.name)
      if (!name) throw this.protocolError("Function call completion is missing a name.")
      this.toolEnded.add(callId)
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
      if (item.type !== "message" && item.type !== "function_call") {
        events.push({ type: "provider-state", providerId: this.providerId, data: { item } })
      }
      if (item.type === "function_call") {
        const callId = string(item.call_id) || string(item.id) || key
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
      const status = string(response.status)
      const rawReason = incompleteReason(response) || status || type
      const usage = normalizeUsage(object(response.usage))
      this.finished = true
      events.push({
        type: "finish",
        finishReason: finishReason(response, this.sawToolCall),
        rawFinishReason: rawReason,
        usage,
      })
      return events
    }

    if (type === "response.failed" || type === "error") {
      this.finished = true
      const response = object(value.response)
      const error = object(response?.error) ?? object(value.error)
      events.push({
        type: "error",
        error: new ModelProviderError(
          string(error?.message) || "[SixbOpenResponses] Provider response failed.",
          this.providerId,
          this.modelId,
          {
            ...(string(error?.code) || string(error?.type)
              ? { code: string(error?.code) || string(error?.type) }
              : {}),
          }
        ),
      })
      return events
    }

    return events
  }

  private protocolError(message: string): ModelProviderError {
    return new ModelProviderError(`[SixbOpenResponses] ${message}`, this.providerId, this.modelId)
  }
}

function messagesToInput(messages: readonly ModelMessage[], providerId: string): JsonValue[] {
  const input: JsonValue[] = []
  for (const message of messages) {
    if (message.role === "system") {
      input.push({ role: "system", content: [{ type: "input_text", text: message.content }] })
      continue
    }
    if (message.role === "user") {
      input.push({
        role: "user",
        content: message.content.map(userPartToInput),
      })
      continue
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        input.push({
          type: "function_call_output",
          call_id: part.toolCallId,
          output: toolOutputText(part.output),
        })
      }
      continue
    }

    const assistantText: JsonValue[] = []
    const flushAssistantText = () => {
      if (assistantText.length === 0) return
      input.push({ role: "assistant", content: assistantText.splice(0) })
    }
    for (const part of message.content) {
      if (part.type === "provider-state") {
        if (part.providerId === providerId) {
          const data = object(part.data)
          const item = data?.item
          if (isJsonObject(item)) {
            flushAssistantText()
            input.push(item)
          }
        }
        continue
      }
      const raw = providerItem(part.providerData, providerId)
      if (raw) {
        flushAssistantText()
        input.push(raw)
        continue
      }
      if (part.type === "text") {
        assistantText.push({ type: "output_text", text: part.text })
      } else if (part.type === "tool-call") {
        flushAssistantText()
        input.push({
          type: "function_call",
          call_id: part.toolCallId,
          name: part.toolName,
          arguments: JSON.stringify(part.input),
        })
      } else if (part.type === "tool-result" && part.providerExecuted) {
        flushAssistantText()
        input.push({
          type: "function_call_output",
          call_id: part.toolCallId,
          output: toolOutputText(part.output),
        })
      }
    }
    flushAssistantText()
  }
  return input
}

function userPartToInput(
  part: Extract<ModelMessage, { role: "user" }>["content"][number]
): JsonValue {
  if (part.type === "text") return { type: "input_text", text: part.text }
  if (part.mediaType.startsWith("image/")) {
    return { type: "input_image", image_url: part.data.toString(), detail: "auto" }
  }
  return {
    type: "input_file",
    file_data: part.data.toString(),
    ...(part.filename === undefined ? {} : { filename: part.filename }),
  }
}

function providerItem(data: ProviderData | undefined, providerId: string): JsonObject | undefined {
  const provider = data?.[providerId]
  const wrapped = object(provider)
  return object(wrapped?.item)
}

function providerItemData(providerId: string, item: JsonObject): ProviderData {
  return { [providerId]: { item } }
}

function toolOutputText(output: ModelToolOutput): string {
  return output.type === "text" || output.type === "error-text"
    ? output.value
    : JSON.stringify(output.value)
}

function normalizeUsage(raw: JsonObject | undefined): ModelUsage {
  if (!raw) return {}
  const inputTokens = integer(raw.input_tokens)
  const outputTokens = integer(raw.output_tokens)
  const cached = integer(object(raw.input_tokens_details)?.cached_tokens)
  const reasoning = integer(object(raw.output_tokens_details)?.reasoning_tokens)
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(inputTokens === undefined || cached === undefined
      ? {}
      : { uncachedInputTokens: Math.max(0, inputTokens - cached) }),
    ...(cached === undefined ? {} : { cacheReadInputTokens: cached }),
    ...(outputTokens === undefined ? {} : { textOutputTokens: outputTokens }),
    ...(reasoning === undefined ? {} : { reasoningOutputTokens: reasoning }),
    raw,
  }
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

function reasoningSpanId(event: JsonObject): string {
  return `${string(event.item_id) || `output:${integer(event.output_index) ?? 0}`}:reasoning:${integer(event.summary_index) ?? 0}`
}

async function providerHttpError(
  response: Response,
  providerId: string,
  modelId: string
): Promise<ModelProviderError> {
  const raw = (await response.text()).slice(0, 8_192)
  let message = `Provider request failed with HTTP ${response.status}.`
  let code: string | undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    const error = object(object(parsed)?.error) ?? object(parsed)
    message = string(error?.message) || message
    code = string(error?.code) || string(error?.type) || undefined
  } catch {
    // Arbitrary HTML/text bodies stay private; status is enough for the public error.
  }
  return new ModelProviderError(`[SixbOpenResponses] ${message}`, providerId, modelId, {
    status: response.status,
    ...(code === undefined ? {} : { code }),
  })
}

function resolve<T>(source: ValueSource<T> | undefined): T | undefined {
  return typeof source === "function" ? (source as () => T)() : source
}

function object(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function string(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}
