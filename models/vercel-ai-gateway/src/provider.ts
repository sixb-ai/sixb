import {
  assertJsonObject,
  defineLanguageModel,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type LanguageModel,
  type LanguageModelCatalog,
  type LanguageModelDefinition,
  type LanguageModelPricing,
  type LanguageModelProvider,
  type LanguageModelRequest,
  type LanguageModelStreamEvent,
  type ModelCapabilities,
  type ModelFinishReason,
  type ModelMessage,
  ModelProviderError,
  type ModelReportedCost,
  type ModelToolOutput,
  type ModelUsage,
  type ProviderData,
} from "@sixb/core/models"
import { decodeServerSentEvents } from "./sse"

type ValueSource<T> = T | (() => T)

const PROVIDER_ID = "vercel-ai-gateway"
const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1"
const CATALOG_TIMEOUT_MS = 5_000
const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1_000
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000

export interface VercelGatewayOptions {
  readonly baseUrl?: string
  readonly apiKey?: ValueSource<string | undefined>
  readonly headers?: ValueSource<Readonly<Record<string, string>>>
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly catalogTtlMs?: number
  readonly maxRetries?: number
  readonly maxRetryDelayMs?: number
  /** Definitions supplied here override matching entries from Vercel's live catalog. */
  readonly models?: readonly LanguageModelDefinition[]
}

export interface VercelGatewayModelOptions {
  readonly request?: JsonObject
  /** AI Gateway routing, fallback, caching, and provider-specific options. */
  readonly providerOptions?: JsonObject
  /** Provider-native tools such as web search. Local Sixb tools are appended as functions. */
  readonly providerTools?: readonly JsonObject[]
  readonly capabilities?: ModelCapabilities
}

export interface VercelGatewayCatalog extends LanguageModelCatalog {
  refresh(): Promise<readonly LanguageModelDefinition[]>
}

export interface VercelGateway extends LanguageModelProvider {
  (modelId: string, options?: VercelGatewayModelOptions): LanguageModel
  readonly providerId: typeof PROVIDER_ID
  readonly catalog: VercelGatewayCatalog
}

export function createVercelGateway(options: VercelGatewayOptions = {}): VercelGateway {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  if (!URL.canParse(baseUrl) || !["http:", "https:"].includes(new URL(baseUrl).protocol)) {
    throw new TypeError(`[SixbVercelGateway] Invalid base URL '${options.baseUrl}'.`)
  }
  assertPositiveIntegerOption(options.catalogTtlMs, "catalogTtlMs")
  assertNonnegativeInteger(options.maxRetries, "maxRetries")
  assertPositiveIntegerOption(options.maxRetryDelayMs, "maxRetryDelayMs")
  const transport: GatewayTransport = { ...options, baseUrl }
  const catalog = new RemoteVercelGatewayCatalog(transport, options.models ?? [])
  const model = (modelId: string, modelOptions: VercelGatewayModelOptions = {}) => {
    if (!modelId.trim()) {
      throw new TypeError("[SixbVercelGateway] Model id must not be empty.")
    }
    return new VercelGatewayLanguageModel(transport, catalog, modelId, modelOptions)
  }
  return Object.assign(model, { providerId: PROVIDER_ID as typeof PROVIDER_ID, catalog })
}

interface GatewayTransport extends VercelGatewayOptions {
  readonly baseUrl: string
}

/** Shared zero-configuration gateway with the callable provider DX used across Sixb models. */
export const vercelGateway = createVercelGateway({
  apiKey: () => process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN,
})

class RemoteVercelGatewayCatalog implements VercelGatewayCatalog {
  private readonly supplied = new Map<string, LanguageModelDefinition>()
  private loadPromise: Promise<readonly LanguageModelDefinition[]> | undefined
  private loadedAt = 0

  constructor(
    private readonly transport: GatewayTransport,
    definitions: readonly LanguageModelDefinition[]
  ) {
    for (const input of definitions) {
      const definition = defineLanguageModel(input)
      if (definition.providerId !== PROVIDER_ID) {
        throw new TypeError(
          `[SixbVercelGateway] Supplied model '${definition.modelId}' must use providerId '${PROVIDER_ID}'.`
        )
      }
      if (this.supplied.has(definition.modelId)) {
        throw new TypeError(`[SixbVercelGateway] Duplicate model '${definition.modelId}'.`)
      }
      this.supplied.set(definition.modelId, definition)
    }
  }

  async get(modelId: string): Promise<LanguageModelDefinition | undefined> {
    return (
      this.supplied.get(modelId) ?? (await this.load()).find((model) => model.modelId === modelId)
    )
  }

  list(): Promise<readonly LanguageModelDefinition[]> {
    return this.load()
  }

  refresh(): Promise<readonly LanguageModelDefinition[]> {
    this.loadPromise = undefined
    this.loadedAt = 0
    return this.load()
  }

  private load(): Promise<readonly LanguageModelDefinition[]> {
    const ttl = this.transport.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS
    if (this.loadPromise && Date.now() - this.loadedAt >= ttl) this.loadPromise = undefined
    this.loadPromise ??= this.fetchDefinitions()
      .then((definitions) => {
        this.loadedAt = Date.now()
        return definitions
      })
      .catch((error) => {
        this.loadPromise = undefined
        throw error
      })
    return this.loadPromise
  }

  private async fetchDefinitions(): Promise<readonly LanguageModelDefinition[]> {
    const response = await (this.transport.fetch ?? fetch)(`${this.transport.baseUrl}/models`, {
      headers: gatewayHeaders(this.transport, "application/json"),
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    })
    if (!response.ok) throw await providerHttpError(response, PROVIDER_ID, "catalog")
    const body: unknown = await response.json()
    assertJsonObject(body, "Vercel AI Gateway model catalog")
    if (!Array.isArray(body.data)) {
      throw new ModelProviderError(
        "[SixbVercelGateway] Model catalog response is missing its data array.",
        PROVIDER_ID,
        "catalog"
      )
    }
    const discovered = body.data.flatMap((entry): LanguageModelDefinition[] => {
      const definition = catalogDefinition(entry)
      return definition ? [definition] : []
    })
    const merged = new Map(discovered.map((definition) => [definition.modelId, definition]))
    for (const definition of this.supplied.values()) merged.set(definition.modelId, definition)
    return Object.freeze([...merged.values()])
  }
}

function catalogDefinition(value: unknown): LanguageModelDefinition | undefined {
  const model = object(value)
  if (!model || model.type !== "language") return undefined
  const modelId = string(model.id)
  if (!modelId) return undefined
  const tags = stringArray(model.tags)
  const parameters = stringArray(model.supported_parameters)
  const inputModalities = stringArray(object(model.modalities)?.input)
  const pricing = modelPricing(object(model.pricing))
  const released = integer(model.released)
  const description = string(model.description)
  const name = string(model.name)
  const family = string(model.owned_by)
  const knowledgeCutoff = string(model.knowledge)
  const contextWindow = positiveInteger(model.context_window)
  const maxOutputTokens = positiveInteger(model.max_tokens)
  const inputMediaTypes = inputModalities.flatMap((modality) => {
    if (modality === "image") return ["image/*"]
    if (modality === "pdf") return ["application/pdf"]
    return []
  })
  const tools = tags.includes("tool-use") || parameters.includes("tools")
  return defineLanguageModel({
    kind: "language",
    providerId: PROVIDER_ID,
    modelId,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(family ? { family } : {}),
    ...(tags.length === 0 ? {} : { tags }),
    ...(released === undefined
      ? {}
      : { releaseDate: new Date(released * 1_000).toISOString().slice(0, 10) }),
    ...(knowledgeCutoff ? { knowledgeCutoff } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    capabilities: {
      ...(inputMediaTypes.length === 0 ? {} : { inputMediaTypes }),
      ...(tags.includes("reasoning") ? { reasoning: true } : {}),
      ...(tools ? { localTools: true, parallelToolCalls: true } : {}),
      ...(parameters.includes("response_format") ? { nativeStructuredOutput: true } : {}),
    },
    ...(pricing === undefined ? {} : { pricing }),
  })
}

function modelPricing(raw: JsonObject | undefined): LanguageModelPricing | undefined {
  if (!raw || raw.varies_by_provider === true) return undefined
  const input = tokenPrice(raw.input, raw.input_tiers)
  const output = tokenPrice(raw.output, raw.output_tiers)
  if (!input || !output) return undefined
  const cacheReadInput = tokenPrice(raw.input_cache_read, raw.input_cache_read_tiers)
  const cacheWriteInput = tokenPrice(raw.input_cache_write, raw.input_cache_write_tiers)
  return {
    currency: "USD",
    unit: "million-tokens",
    input,
    output,
    ...(cacheReadInput === undefined ? {} : { cacheReadInput }),
    ...(cacheWriteInput === undefined ? {} : { cacheWriteInput }),
  }
}

function tokenPrice(base: unknown, rawTiers: unknown): LanguageModelPricing["input"] | undefined {
  if (typeof base !== "string" || !decimal(base)) return undefined
  const defaultPrice = perTokenToPerMillion(base)
  if (!Array.isArray(rawTiers)) return defaultPrice
  const tiers = rawTiers.flatMap((value) => {
    const tier = object(value)
    const cost = string(tier?.cost)
    const minTokens = integer(tier?.min)
    const maxTokens = positiveInteger(tier?.max)
    if (!cost || !decimal(cost) || minTokens === undefined) return []
    return [
      {
        minTokens,
        ...(maxTokens === undefined ? {} : { maxTokens }),
        price: perTokenToPerMillion(cost),
      },
    ]
  })
  return tiers.length === 0 ? defaultPrice : { default: defaultPrice, tiers }
}

function perTokenToPerMillion(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".")
  const digits = `${whole}${fraction}`
  const decimalIndex = whole.length + 6
  const shifted =
    decimalIndex >= digits.length
      ? `${digits}${"0".repeat(decimalIndex - digits.length)}`
      : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`
  const [shiftedWhole = "0", shiftedFraction = ""] = shifted.split(".")
  const normalizedWhole = shiftedWhole.replace(/^0+(?=\d)/, "") || "0"
  const normalizedFraction = shiftedFraction.replace(/0+$/, "")
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole
}

function fallbackDefinition(modelId: string): LanguageModelDefinition {
  return defineLanguageModel({
    kind: "language",
    providerId: PROVIDER_ID,
    modelId,
    capabilities: {},
  })
}

class VercelGatewayLanguageModel implements LanguageModel {
  readonly providerId = PROVIDER_ID
  readonly modelId: string
  readonly definition: () => Promise<LanguageModelDefinition>

  constructor(
    private readonly transport: GatewayTransport,
    catalog: RemoteVercelGatewayCatalog,
    modelId: string,
    private readonly options: VercelGatewayModelOptions
  ) {
    this.modelId = modelId
    if (options.request !== undefined) {
      assertJsonObject(options.request, "model request options")
    }
    if (options.providerOptions !== undefined) {
      assertJsonObject(options.providerOptions, "model provider options")
    }
    for (const [index, tool] of (options.providerTools ?? []).entries()) {
      assertJsonObject(tool, `providerTools[${index}]`)
    }
    this.definition = async () => {
      let resolved: LanguageModelDefinition | undefined
      try {
        resolved = await catalog.get(modelId)
      } catch {
        // Catalog enrichment must never make a healthy inference endpoint unavailable.
      }
      return defineLanguageModel({
        ...(resolved ?? fallbackDefinition(modelId)),
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      })
    }
  }

  async stream(request: LanguageModelRequest) {
    const init: RequestInit = {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(request)),
      signal: request.signal,
    }
    let response: Response
    for (let attempt = 0; ; attempt += 1) {
      response = await (this.transport.fetch ?? fetch)(`${this.transport.baseUrl}/responses`, init)
      if (response.ok) break
      const error = await providerHttpError(response, this.providerId, this.modelId)
      if (!error.retryable || attempt >= (this.transport.maxRetries ?? DEFAULT_MAX_RETRIES)) {
        throw error
      }
      await waitForRetry(error, request.signal, this.transport.maxRetryDelayMs)
    }
    if (!response.body) {
      const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id")
      throw new ModelProviderError(
        "[SixbVercelGateway] Provider returned an empty streaming response.",
        this.providerId,
        this.modelId,
        {
          status: response.status,
          ...(requestId === null ? {} : { requestId }),
        }
      )
    }
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id")
    return { events: this.responseEvents(response.body, request.signal, requestId ?? undefined) }
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...gatewayHeaders(this.transport, "text/event-stream"),
    }
  }

  private requestBody(request: LanguageModelRequest): JsonObject {
    const extra = this.options.request ?? {}
    for (const reserved of [
      "model",
      "input",
      "tools",
      "stream",
      "reasoning",
      "text",
      "providerOptions",
    ]) {
      if (Object.hasOwn(extra, reserved)) {
        throw new TypeError(
          `[SixbVercelGateway] Model request option '${reserved}' is owned by the adapter.`
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
      ...(this.options.providerOptions === undefined
        ? {}
        : { providerOptions: this.options.providerOptions }),
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
    signal: AbortSignal,
    requestId?: string
  ): AsyncIterable<LanguageModelStreamEvent> {
    const state = new ResponseState(this.providerId, this.modelId, requestId)
    for await (const event of decodeServerSentEvents(body, signal)) {
      if (event.data === "[DONE]") break
      let value: unknown
      try {
        value = JSON.parse(event.data)
      } catch (error) {
        throw new ModelProviderError(
          "[SixbVercelGateway] Provider emitted invalid SSE JSON.",
          this.providerId,
          this.modelId,
          {
            cause: error,
            ...(requestId === undefined ? {} : { requestId }),
          }
        )
      }
      assertJsonObject(value, "Vercel AI Gateway SSE data")
      for (const normalized of state.accept(event.event ?? string(value.type), value)) {
        yield normalized
      }
    }
    if (!state.finished) {
      throw new ModelProviderError(
        "[SixbVercelGateway] Provider stream ended without a terminal response event.",
        this.providerId,
        this.modelId,
        requestId === undefined ? undefined : { requestId }
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
    private readonly modelId: string,
    private readonly requestId?: string
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
      const metadata = gatewayMetadata(response)
      const reportedCost = gatewayReportedCost(metadata)
      const route = gatewayRoute(metadata)
      this.finished = true
      events.push({
        type: "finish",
        finishReason: finishReason(response, this.sawToolCall),
        rawFinishReason: rawReason,
        usage,
        ...(metadata === undefined ? {} : { providerData: { [this.providerId]: metadata } }),
        ...(reportedCost === undefined ? {} : { reportedCost }),
        ...(route === undefined ? {} : { route }),
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
          string(error?.message) || "[SixbVercelGateway] Provider response failed.",
          this.providerId,
          this.modelId,
          {
            ...(string(error?.code) || string(error?.type)
              ? { code: string(error?.code) || string(error?.type) }
              : {}),
            ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
          }
        ),
      })
      return events
    }

    return events
  }

  private protocolError(message: string): ModelProviderError {
    return new ModelProviderError(`[SixbVercelGateway] ${message}`, this.providerId, this.modelId, {
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
    })
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
  const cachedRaw = integer(object(raw.input_tokens_details)?.cached_tokens)
  const cached = cachedRaw ?? (inputTokens === undefined ? undefined : 0)
  const reasoning = integer(object(raw.output_tokens_details)?.reasoning_tokens)
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(inputTokens === undefined || cached === undefined
      ? {}
      : { uncachedInputTokens: Math.max(0, inputTokens - cached) }),
    ...(cached === undefined ? {} : { cacheReadInputTokens: cached }),
    ...(outputTokens === undefined
      ? {}
      : { textOutputTokens: Math.max(0, outputTokens - (reasoning ?? 0)) }),
    ...(reasoning === undefined ? {} : { reasoningOutputTokens: reasoning }),
    raw,
  }
}

function gatewayMetadata(response: JsonObject): JsonObject | undefined {
  return (
    object(object(response.provider_metadata)?.gateway) ??
    object(object(response.providerMetadata)?.gateway) ??
    object(response.gateway)
  )
}

function gatewayReportedCost(metadata: JsonObject | undefined): ModelReportedCost | undefined {
  const raw = metadata?.cost
  const numericNanos =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0
      ? Math.round(raw * 1_000_000_000)
      : undefined
  const amountNanos =
    numericNanos !== undefined && Number.isSafeInteger(numericNanos)
      ? numericNanos.toString()
      : decimal(string(raw))
        ? dollarsToNanos(string(raw))
        : undefined
  if (amountNanos === undefined) return undefined
  return {
    money: { currency: "USD", amountNanos },
    providerId: PROVIDER_ID,
  }
}

function gatewayRoute(
  metadata: JsonObject | undefined
): { readonly providerId?: string; readonly modelId?: string } | undefined {
  const routing = object(metadata?.routing)
  const providerId =
    string(routing?.finalProvider) ||
    string(metadata?.provider) ||
    string(metadata?.providerId) ||
    string(metadata?.provider_name)
  const modelId =
    string(routing?.finalModel) || string(metadata?.model) || string(metadata?.modelId)
  return providerId || modelId
    ? { ...(providerId ? { providerId } : {}), ...(modelId ? { modelId } : {}) }
    : undefined
}

function dollarsToNanos(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".")
  const firstNine = fraction.slice(0, 9).padEnd(9, "0")
  const roundUp = Number(fraction[9] ?? "0") >= 5
  return (BigInt(whole) * 1_000_000_000n + BigInt(firstNine) + (roundUp ? 1n : 0n)).toString()
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
  return new ModelProviderError(`[SixbVercelGateway] ${message}`, providerId, modelId, {
    status: response.status,
    ...(code === undefined ? {} : { code }),
    ...requestErrorMetadata(response),
  })
}

function requestErrorMetadata(response: Response): {
  readonly requestId?: string
  readonly retryAfterMs?: number
  readonly retryable: boolean
} {
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id")
  const retryAfterMs =
    parseMilliseconds(response.headers.get("retry-after-ms")) ??
    parseRetryAfter(response.headers.get("retry-after"))
  return {
    ...(requestId === null ? {} : { requestId }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    retryable: response.status === 429 || response.status >= 500,
  }
}

function parseMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined
  const milliseconds = Number(value)
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.ceil(milliseconds) : undefined
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

async function waitForRetry(
  error: ModelProviderError,
  signal: AbortSignal,
  maxDelayMs = DEFAULT_MAX_RETRY_DELAY_MS
): Promise<void> {
  const delay = Math.min(error.retryAfterMs ?? 250, maxDelayMs)
  if (delay <= 0) return
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException("The request was aborted.", "AbortError"))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, delay)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

function resolve<T>(source: ValueSource<T> | undefined): T | undefined {
  return typeof source === "function" ? (source as () => T)() : source
}

function gatewayHeaders(transport: GatewayTransport, accept: string): Record<string, string> {
  const headers = resolve(transport.headers) ?? {}
  const apiKey = resolve(transport.apiKey)
  return {
    accept,
    ...headers,
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  }
}

function decimal(value: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
}

function object(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function string(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = integer(value)
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}

function assertPositiveIntegerOption(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`[SixbVercelGateway] ${field} must be a positive integer.`)
  }
}

function assertNonnegativeInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`[SixbVercelGateway] ${field} must be a nonnegative integer.`)
  }
}
