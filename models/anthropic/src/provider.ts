import {
  assertJsonObject,
  defineLanguageModel,
  isJsonObject,
  type JsonObject,
  type LanguageModel,
  type LanguageModelCatalog,
  type LanguageModelDefinition,
  type LanguageModelProvider,
  type LanguageModelRequest,
  type LanguageModelStreamEvent,
  MODEL_REASONING_EFFORTS,
  type ModelCapabilities,
  type ModelFinishReason,
  type ModelMessage,
  ModelProviderError,
  type ModelReasoningCapabilities,
  type ModelReasoningEffort,
  type ModelToolOutput,
  type ModelUsage,
  modelReasoningSupportIssue,
  type ProviderData,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import {
  anthropicMaxOutputTokens,
  anthropicRateCard,
  applyAnthropicRateCardModifiers,
} from "./model-details"
import { decodeServerSentEvents } from "./sse"
import { anthropicOutputSchema } from "./structured-output"

type ValueSource<T> = T | (() => T)

const PROVIDER_ID = "anthropic"
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
const DEFAULT_API_VERSION = "2023-06-01"
const CATALOG_TIMEOUT_MS = 5_000
const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1_000
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000
const OUTPUT_TOOL_NAME = "sixb_structured_output"
const ANTHROPIC_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const

export interface AnthropicOptions {
  readonly baseUrl?: string
  readonly apiKey?: ValueSource<string | undefined>
  readonly apiVersion?: string
  readonly betas?: ValueSource<readonly string[]>
  readonly headers?: ValueSource<Readonly<Record<string, string>>>
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly catalogTtlMs?: number
  readonly maxRetries?: number
  readonly maxRetryDelayMs?: number
  /** Definitions supplied here override matching entries from Anthropic's live catalog. */
  readonly models?: readonly LanguageModelDefinition[]
}

export interface AnthropicModelOptions {
  readonly maxOutputTokens?: number
  /** Additional native Messages API fields. Adapter-owned fields are rejected or merged safely. */
  readonly request?: JsonObject
  /** Anthropic server tools such as web search. Local Sixb tools are appended as client tools. */
  readonly providerTools?: readonly JsonObject[]
  readonly capabilities?: ModelCapabilities
}

export interface AnthropicCatalog extends LanguageModelCatalog {
  refresh(): Promise<readonly LanguageModelDefinition[]>
}

export interface AnthropicProvider extends LanguageModelProvider {
  (modelId: string, options?: AnthropicModelOptions): LanguageModel
  readonly providerId: typeof PROVIDER_ID
  readonly catalog: AnthropicCatalog
}

export function createAnthropic(options: AnthropicOptions = {}): AnthropicProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  if (!URL.canParse(baseUrl) || !["http:", "https:"].includes(new URL(baseUrl).protocol)) {
    throw new TypeError(`[SixbAnthropic] Invalid base URL '${options.baseUrl}'.`)
  }
  const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION
  if (!apiVersion.trim()) throw new TypeError("[SixbAnthropic] API version must not be empty.")
  assertNonnegativeInteger(options.maxRetries, "maxRetries")
  assertPositiveIntegerOption(options.catalogTtlMs, "catalogTtlMs")
  assertPositiveIntegerOption(options.maxRetryDelayMs, "maxRetryDelayMs")
  const transport: AnthropicTransport = { ...options, baseUrl, apiVersion }
  const configuredModels = configuredModelDefinitions(options.models ?? [])
  const catalog = new RemoteAnthropicCatalog(transport, configuredModels)
  const model = (modelId: string, modelOptions: AnthropicModelOptions = {}) => {
    if (!modelId.trim()) throw new TypeError("[SixbAnthropic] Model id must not be empty.")
    return new AnthropicLanguageModel(
      transport,
      catalog,
      modelId,
      modelOptions,
      configuredModels.get(modelId)
    )
  }
  return Object.assign(model, { providerId: PROVIDER_ID as typeof PROVIDER_ID, catalog })
}

interface AnthropicTransport extends AnthropicOptions {
  readonly baseUrl: string
  readonly apiVersion: string
}

function configuredModelDefinitions(
  definitions: readonly LanguageModelDefinition[]
): ReadonlyMap<string, LanguageModelDefinition> {
  const configured = new Map<string, LanguageModelDefinition>()
  for (const input of definitions) {
    const definition = defineLanguageModel(input)
    if (definition.providerId !== PROVIDER_ID) {
      throw new TypeError(
        `[SixbAnthropic] Supplied model '${definition.modelId}' must use providerId '${PROVIDER_ID}'.`
      )
    }
    if (configured.has(definition.modelId)) {
      throw new TypeError(`[SixbAnthropic] Duplicate model '${definition.modelId}'.`)
    }
    configured.set(definition.modelId, definition)
  }
  return configured
}

/** Shared zero-configuration Anthropic provider. */
export const anthropic = createAnthropic({
  apiKey: () => process.env.ANTHROPIC_API_KEY,
})

class RemoteAnthropicCatalog implements AnthropicCatalog {
  private loadPromise: Promise<readonly LanguageModelDefinition[]> | undefined
  private loadedAt = 0

  constructor(
    private readonly transport: AnthropicTransport,
    private readonly supplied: ReadonlyMap<string, LanguageModelDefinition>
  ) {}

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
    const discovered = new Map<string, LanguageModelDefinition>()
    let afterId: string | undefined
    for (;;) {
      const url = new URL(`${this.transport.baseUrl}/models`)
      url.searchParams.set("limit", "1000")
      if (afterId) url.searchParams.set("after_id", afterId)
      const response = await (this.transport.fetch ?? fetch)(url, {
        headers: anthropicHeaders(this.transport, "application/json"),
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      })
      if (!response.ok) throw await providerHttpError(response, PROVIDER_ID, "catalog")
      const body: unknown = await response.json()
      assertJsonObject(body, "Anthropic model catalog")
      if (!Array.isArray(body.data)) {
        throw new ModelProviderError(
          "[SixbAnthropic] Model catalog response is missing its data array.",
          PROVIDER_ID,
          "catalog"
        )
      }
      for (const entry of body.data) {
        const definition = catalogDefinition(entry)
        if (definition) discovered.set(definition.modelId, definition)
      }
      if (body.has_more !== true) break
      const next = string(body.last_id)
      if (!next || next === afterId) {
        throw new ModelProviderError(
          "[SixbAnthropic] Model catalog pagination did not advance.",
          PROVIDER_ID,
          "catalog"
        )
      }
      afterId = next
    }
    for (const definition of this.supplied.values()) {
      discovered.set(definition.modelId, definition)
    }
    return Object.freeze([...discovered.values()])
  }
}

function catalogDefinition(value: unknown): LanguageModelDefinition | undefined {
  const model = object(value)
  const modelId = string(model?.id)
  if (!modelId || (model?.type !== undefined && model.type !== "model")) return undefined
  const capabilities = object(model?.capabilities)
  const inputMediaTypes = [
    ...(supported(capabilities, "image_input") ? ANTHROPIC_IMAGE_MEDIA_TYPES : []),
    ...(supported(capabilities, "pdf_input") ? ["application/pdf"] : []),
  ]
  const releaseDate = date(string(model?.created_at))
  const name = string(model?.display_name)
  const contextWindow = positiveInteger(model?.max_input_tokens)
  const maxOutputTokens = positiveInteger(model?.max_tokens)
  const providerTools = ["code_execution", "web_search", "web_fetch"].some((name) =>
    supported(capabilities, name)
  )
  const reasoning = anthropicReasoningCapabilities(capabilities)
  const rateCard = anthropicRateCard(modelId, undefined)
  return defineLanguageModel({
    kind: "language",
    providerId: PROVIDER_ID,
    modelId,
    ...(name ? { name } : {}),
    family: "Claude",
    ...(releaseDate ? { releaseDate } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    capabilities: {
      ...(inputMediaTypes.length === 0 ? {} : { inputMediaTypes }),
      ...(reasoning === undefined ? {} : { reasoning }),
      localTools: true,
      parallelToolCalls: true,
      ...(supported(capabilities, "structured_outputs") ? { nativeStructuredOutput: true } : {}),
      ...(providerTools ? { providerExecutedTools: true } : {}),
    },
    ...(rateCard === undefined ? {} : { rateCard }),
  })
}

function fallbackDefinition(modelId: string): LanguageModelDefinition {
  const rateCard = anthropicRateCard(modelId, undefined)
  const maxOutputTokens = anthropicMaxOutputTokens(modelId)
  return defineLanguageModel({
    kind: "language",
    providerId: PROVIDER_ID,
    modelId,
    family: "Claude",
    capabilities: {
      inputMediaTypes: ANTHROPIC_IMAGE_MEDIA_TYPES,
      localTools: true,
      parallelToolCalls: true,
    },
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(rateCard === undefined ? {} : { rateCard }),
  })
}

class AnthropicLanguageModel implements LanguageModel {
  readonly providerId = PROVIDER_ID
  readonly modelId: string
  readonly definition: LanguageModelDefinition
  private readonly maxOutputTokens: number

  constructor(
    private readonly transport: AnthropicTransport,
    private readonly catalog: AnthropicCatalog,
    modelId: string,
    private readonly options: AnthropicModelOptions,
    configuredDefinition: LanguageModelDefinition | undefined
  ) {
    this.modelId = modelId
    const base = configuredDefinition ?? fallbackDefinition(modelId)
    const modelMaxOutputTokens = base.maxOutputTokens ?? anthropicMaxOutputTokens(modelId)
    const maxOutputTokens = options.maxOutputTokens ?? modelMaxOutputTokens
    if (maxOutputTokens === undefined) {
      throw new TypeError(
        `[SixbAnthropic] maxOutputTokens is required for unknown model '${modelId}'.`
      )
    }
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      throw new TypeError("[SixbAnthropic] maxOutputTokens must be a positive integer.")
    }
    if (modelMaxOutputTokens !== undefined && maxOutputTokens > modelMaxOutputTokens) {
      throw new TypeError(
        `[SixbAnthropic] maxOutputTokens must not exceed model '${modelId}' maximum (${modelMaxOutputTokens}).`
      )
    }
    this.maxOutputTokens = maxOutputTokens
    if (options.request !== undefined) assertJsonObject(options.request, "model request options")
    for (const [index, tool] of (options.providerTools ?? []).entries()) {
      assertJsonObject(tool, `providerTools[${index}]`)
    }
    const { rateCard: baseRateCard, ...definition } = base
    // Server tools may add request- or duration-based charges that token rates cannot represent.
    const rateCard =
      (options.providerTools?.length ?? 0) > 0
        ? undefined
        : baseRateCard
          ? applyAnthropicRateCardModifiers(baseRateCard, modelId, options.request)
          : anthropicRateCard(modelId, options.request)
    this.definition = defineLanguageModel({
      ...definition,
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      ...(rateCard === undefined ? {} : { rateCard }),
    })
  }

  async stream(request: LanguageModelRequest) {
    const url = `${this.transport.baseUrl}/messages`
    const prepared = await this.prepareRequest(request)
    const init: RequestInit = {
      method: "POST",
      headers: anthropicHeaders(this.transport, "text/event-stream", true),
      body: JSON.stringify(prepared.body),
      signal: request.signal,
    }
    let response: Response
    for (let attempt = 0; ; attempt += 1) {
      response = await (this.transport.fetch ?? fetch)(url, init)
      if (response.ok) break
      const error = await providerHttpError(response, this.providerId, this.modelId)
      if (!error.retryable || attempt >= (this.transport.maxRetries ?? DEFAULT_MAX_RETRIES)) {
        throw error
      }
      await waitForRetry(error, request.signal, this.transport.maxRetryDelayMs)
    }
    const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id")
    if (!response.body) {
      throw new ModelProviderError(
        "[SixbAnthropic] Provider returned an empty streaming response.",
        this.providerId,
        this.modelId,
        {
          status: response.status,
          ...(requestId === null ? {} : { requestId }),
        }
      )
    }
    return {
      events: this.responseEvents(
        response.body,
        request.signal,
        requestId ?? undefined,
        prepared.outputToolName
      ),
    }
  }

  private async prepareRequest(request: LanguageModelRequest): Promise<{
    readonly body: JsonObject
    readonly outputToolName?: string
  }> {
    const extra = this.options.request ?? {}
    for (const reserved of [
      "model",
      "messages",
      "system",
      "tools",
      "tool_choice",
      "stream",
      "max_tokens",
      "thinking",
      "disable_parallel_tool_use",
    ]) {
      if (Object.hasOwn(extra, reserved)) {
        throw new TypeError(
          `[SixbAnthropic] Model request option '${reserved}' is owned by the adapter.`
        )
      }
    }
    const mapped = messagesToAnthropic(request.messages, this.providerId)
    const nativeOutputSchema =
      request.responseFormat !== undefined && (await this.supportsNativeStructuredOutput())
        ? anthropicOutputSchema(request.responseFormat.schema)
        : undefined
    const useOutputTool = request.responseFormat !== undefined && nativeOutputSchema === undefined
    const tools: JsonObject[] = [
      ...(this.options.providerTools ?? []),
      ...request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        strict: true,
      })),
      ...(useOutputTool
        ? [
            {
              name: OUTPUT_TOOL_NAME,
              description:
                request.responseFormat?.description ?? "Return the final structured result.",
              input_schema: request.responseFormat?.schema ?? {},
            },
          ]
        : []),
    ]
    if (
      useOutputTool &&
      tools.slice(0, -1).some((tool) => string(tool.name) === OUTPUT_TOOL_NAME)
    ) {
      throw new TypeError(`[SixbAnthropic] Tool name '${OUTPUT_TOOL_NAME}' is reserved.`)
    }
    const existingOutputConfig = object(extra.output_config)
    if (extra.output_config !== undefined && !existingOutputConfig) {
      throw new TypeError("[SixbAnthropic] Model request option 'output_config' must be an object.")
    }
    if (existingOutputConfig?.format !== undefined) {
      throw new TypeError(
        "[SixbAnthropic] Model request option 'output_config.format' is owned by the adapter."
      )
    }
    const reasoning = anthropicReasoningRequest(
      request.reasoning,
      this.definition.capabilities.reasoning,
      this.maxOutputTokens,
      this.modelId
    )
    const outputConfig: JsonObject = {
      ...(existingOutputConfig ?? {}),
      ...(reasoning.effort === undefined ? {} : { effort: reasoning.effort }),
      ...(nativeOutputSchema === undefined
        ? {}
        : {
            format: {
              type: "json_schema",
              schema: nativeOutputSchema,
            },
          }),
    }
    return {
      body: {
        ...extra,
        model: this.modelId,
        messages: mapped.messages,
        stream: true,
        max_tokens: this.maxOutputTokens,
        ...(mapped.system.length === 0 ? {} : { system: mapped.system }),
        ...(tools.length === 0
          ? {}
          : {
              tools,
              tool_choice: { type: useOutputTool ? "any" : "auto" },
              ...(useOutputTool ? { disable_parallel_tool_use: true } : {}),
            }),
        ...(Object.keys(outputConfig).length === 0 ? {} : { output_config: outputConfig }),
        ...(reasoning.thinking === undefined ? {} : { thinking: reasoning.thinking }),
      },
      ...(useOutputTool ? { outputToolName: OUTPUT_TOOL_NAME } : {}),
    }
  }

  private async supportsNativeStructuredOutput(): Promise<boolean> {
    const declared = this.definition.capabilities.nativeStructuredOutput
    if (declared !== undefined) return declared
    try {
      return (await this.catalog.get(this.modelId))?.capabilities.nativeStructuredOutput === true
    } catch {
      return false
    }
  }

  private async *responseEvents(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    requestId?: string,
    outputToolName?: string
  ): AsyncIterable<LanguageModelStreamEvent> {
    const state = new MessageState(this.providerId, this.modelId, requestId, outputToolName)
    for await (const event of decodeServerSentEvents(body, signal)) {
      let value: unknown
      try {
        value = JSON.parse(event.data)
      } catch (error) {
        throw new ModelProviderError(
          "[SixbAnthropic] Provider emitted invalid SSE JSON.",
          this.providerId,
          this.modelId,
          {
            cause: error,
            ...(requestId === undefined ? {} : { requestId }),
          }
        )
      }
      assertJsonObject(value, "Anthropic SSE data")
      for (const normalized of state.accept(event.event ?? string(value.type), value)) {
        yield normalized
      }
    }
    if (!state.finished) {
      throw new ModelProviderError(
        "[SixbAnthropic] Provider stream ended without a terminal message event.",
        this.providerId,
        this.modelId,
        requestId === undefined ? undefined : { requestId }
      )
    }
  }
}

interface ContentBlockState {
  readonly id: string
  readonly type: string
  readonly raw: JsonObject
  readonly structuredOutput: boolean
  toolInput: string
}

class MessageState {
  private readonly blocks = new Map<number, ContentBlockState>()
  private usage: JsonObject = {}
  private stopReason = ""
  private started = false
  private outputToolSeen = false
  finished = false

  constructor(
    private readonly providerId: string,
    private readonly modelId: string,
    private readonly requestId?: string,
    private readonly outputToolName?: string
  ) {}

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
            `[SixbAnthropic] ${string(error?.message) || "Provider response failed."}`,
            this.providerId,
            this.modelId,
            {
              ...(string(error?.type) ? { code: string(error?.type) } : {}),
              ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
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
          finishReason:
            this.outputToolSeen && this.stopReason === "tool_use"
              ? "stop"
              : finishReason(this.stopReason),
          ...(this.stopReason ? { rawFinishReason: this.stopReason } : {}),
          usage: normalizeUsage(this.usage),
        },
      ]
    }
    // Anthropic may add event types without a version bump. Unknown events are ignored safely.
    return []
  }

  private startMessage(value: JsonObject): readonly LanguageModelStreamEvent[] {
    if (this.started) throw this.protocolError("Received duplicate message_start.")
    this.started = true
    const message = object(value.message)
    this.usage = mergeJson(this.usage, object(message?.usage))
    const id = string(message?.id)
    const modelId = string(message?.model)
    return [
      { type: "stream-start" },
      ...(id || modelId
        ? [
            {
              type: "response-metadata" as const,
              ...(id ? { id } : {}),
              ...(modelId ? { modelId } : {}),
            },
          ]
        : []),
    ]
  }

  private startBlock(value: JsonObject): readonly LanguageModelStreamEvent[] {
    const index = requiredIndex(value.index, "content block")
    if (this.blocks.has(index)) throw this.protocolError(`Duplicate content block ${index}.`)
    const raw = object(value.content_block)
    const type = string(raw?.type)
    if (!raw || !type) throw this.protocolError(`Content block ${index} is missing its type.`)
    const id = `content:${index}`
    const structuredOutput =
      type === "tool_use" &&
      this.outputToolName !== undefined &&
      string(raw.name) === this.outputToolName
    if (structuredOutput && this.outputToolSeen) {
      throw this.protocolError("Model submitted structured output more than once.")
    }
    if (structuredOutput) this.outputToolSeen = true
    const block: ContentBlockState = {
      id,
      type,
      raw: { ...raw },
      structuredOutput,
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
      return structuredOutput
        ? [{ type: "text-start", id }]
        : [{ type: "tool-input-start", id: callId, toolName: name }]
    }
    return []
  }

  private deltaBlock(value: JsonObject): readonly LanguageModelStreamEvent[] {
    const index = requiredIndex(value.index, "content block delta")
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
      block.raw.signature = string(delta?.signature)
      return []
    }
    if (type === "input_json_delta" && ["tool_use", "server_tool_use"].includes(block.type)) {
      const partial = string(delta?.partial_json)
      block.toolInput += partial
      return block.structuredOutput
        ? [{ type: "text-delta", id: block.id, delta: partial }]
        : block.type === "tool_use"
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
    const index = requiredIndex(value.index, "content block stop")
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
      if (block.structuredOutput) {
        return [
          ...(hadToolDelta
            ? []
            : [{ type: "text-delta" as const, id: block.id, delta: block.toolInput }]),
          { type: "text-end", id: block.id },
        ]
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
    return new ModelProviderError(`[SixbAnthropic] ${message}`, this.providerId, this.modelId, {
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
    })
  }
}

function messagesToAnthropic(
  messages: readonly ModelMessage[],
  providerId: string
): { readonly system: JsonObject[]; readonly messages: JsonObject[] } {
  const system: JsonObject[] = []
  const mapped: JsonObject[] = []
  for (const message of messages) {
    if (message.role === "system") {
      system.push(
        providerBlock(message.providerData, providerId) ?? { type: "text", text: message.content }
      )
      continue
    }
    if (message.role === "user") {
      mapped.push({
        role: "user",
        content: message.content.map((part) => userBlock(part, providerId)),
      })
      continue
    }
    if (message.role === "tool") {
      mapped.push({
        role: "user",
        content: message.content.map(
          (part) =>
            providerBlock(part.providerData, providerId) ?? {
              type: "tool_result",
              tool_use_id: part.toolCallId,
              content: toolOutputText(part.output),
              ...(part.output.type === "error-text" || part.output.type === "error-json"
                ? { is_error: true }
                : {}),
            }
        ),
      })
      continue
    }
    const content: JsonObject[] = []
    for (const part of message.content) {
      if (part.type === "provider-state") {
        if (part.providerId === providerId) {
          const block = object(part.data)?.block
          if (isJsonObject(block)) content.push(block)
        }
        continue
      }
      const raw = providerBlock(part.providerData, providerId)
      if (raw) {
        content.push(raw)
      } else if (part.type === "text") {
        content.push({ type: "text", text: part.text })
      } else if (part.type === "tool-call") {
        content.push({
          type: "tool_use",
          id: part.toolCallId,
          name: part.toolName,
          input: part.input,
        })
      } else if (part.type === "tool-result" && part.providerExecuted) {
        content.push({
          type: "tool_result",
          tool_use_id: part.toolCallId,
          content: toolOutputText(part.output),
        })
      }
      // Reasoning from another provider is not portable and must not be synthesized as thinking.
    }
    if (content.length > 0) mapped.push({ role: "assistant", content })
  }
  return { system, messages: coalesceRoles(mapped) }
}

function coalesceRoles(messages: readonly JsonObject[]): JsonObject[] {
  const result: JsonObject[] = []
  for (const message of messages) {
    const previous = result.at(-1)
    if (
      previous?.role === message.role &&
      Array.isArray(previous.content) &&
      Array.isArray(message.content)
    ) {
      previous.content = [...previous.content, ...message.content]
    } else {
      result.push(message)
    }
  }
  return result
}

function userBlock(
  part: Extract<ModelMessage, { role: "user" }>["content"][number],
  providerId: string
): JsonObject {
  const raw = providerBlock(part.providerData, providerId)
  if (raw) return raw
  if (part.type === "text") return { type: "text", text: part.text }
  if ((ANTHROPIC_IMAGE_MEDIA_TYPES as readonly string[]).includes(part.mediaType)) {
    return { type: "image", source: mediaSource(part.data, part.mediaType) }
  }
  if (part.mediaType === "application/pdf") {
    return { type: "document", source: mediaSource(part.data, part.mediaType) }
  }
  throw new TypeError(`[SixbAnthropic] Unsupported file media type '${part.mediaType}'.`)
}

function mediaSource(data: URL, mediaType: string): JsonObject {
  if (data.protocol !== "data:") return { type: "url", url: data.toString() }
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(data.toString())
  if (!match) throw new TypeError("[SixbAnthropic] File data URLs must use base64 encoding.")
  const [, encodedMediaType = "", encodedData = ""] = match
  if (encodedMediaType !== mediaType) {
    throw new TypeError(
      `[SixbAnthropic] File data URL media type '${encodedMediaType}' does not match '${mediaType}'.`
    )
  }
  return { type: "base64", media_type: mediaType, data: encodedData }
}

function providerBlock(data: ProviderData | undefined, providerId: string): JsonObject | undefined {
  return object(object(data?.[providerId])?.block)
}

function blockData(providerId: string, block: JsonObject): ProviderData {
  return { [providerId]: { block } }
}

function toolOutputText(output: ModelToolOutput): string {
  return output.type === "text" || output.type === "error-text"
    ? output.value
    : JSON.stringify(output.value)
}

function anthropicReasoningRequest(
  reasoning: LanguageModelRequest["reasoning"],
  capabilities: ModelCapabilities["reasoning"],
  maxOutputTokens: number,
  modelId: string
): { readonly effort?: ModelReasoningEffort; readonly thinking?: JsonObject } {
  const issue = modelReasoningSupportIssue(capabilities, reasoning)
  if (issue) {
    throw new UnsupportedModelFeatureError(`[SixbAnthropic] Model '${modelId}' ${issue}.`)
  }
  if (reasoning === undefined || reasoning === "provider-default") return {}
  if (reasoning === "none") return { thinking: { type: "disabled" } }
  if (typeof reasoning === "string") {
    if (reasoning === "minimal") {
      throw new UnsupportedModelFeatureError(
        `[SixbAnthropic] Model '${modelId}' does not support reasoning effort 'minimal'.`
      )
    }
    return { effort: reasoning }
  }
  if (reasoning.budgetTokens < 1_024) {
    throw new UnsupportedModelFeatureError(
      `[SixbAnthropic] Model '${modelId}' reasoning token budget must be at least 1024.`
    )
  }
  if (reasoning.budgetTokens >= maxOutputTokens) {
    throw new UnsupportedModelFeatureError(
      `[SixbAnthropic] Model '${modelId}' reasoning token budget must be below maxOutputTokens (${maxOutputTokens}).`
    )
  }
  return { thinking: { type: "enabled", budget_tokens: reasoning.budgetTokens } }
}

function normalizeUsage(raw: JsonObject): ModelUsage {
  const uncached = integer(raw.input_tokens)
  const cacheReadRaw = integer(raw.cache_read_input_tokens)
  const cacheWriteRaw = integer(raw.cache_creation_input_tokens)
  const cacheCreation = object(raw.cache_creation)
  const cacheWrite5mRaw = integer(cacheCreation?.ephemeral_5m_input_tokens)
  const cacheWrite1hRaw = integer(cacheCreation?.ephemeral_1h_input_tokens)
  const cacheRead = cacheReadRaw ?? (uncached === undefined ? undefined : 0)
  const cacheWrite =
    cacheWriteRaw ??
    (cacheWrite5mRaw === undefined && cacheWrite1hRaw === undefined
      ? uncached === undefined
        ? undefined
        : 0
      : (cacheWrite5mRaw ?? 0) + (cacheWrite1hRaw ?? 0))
  const hasExactCacheWriteBreakdown =
    cacheWrite5mRaw !== undefined || cacheWrite1hRaw !== undefined || cacheWrite === 0
  const cacheWrite5m = hasExactCacheWriteBreakdown ? (cacheWrite5mRaw ?? 0) : undefined
  const cacheWrite1h = hasExactCacheWriteBreakdown ? (cacheWrite1hRaw ?? 0) : undefined
  const outputTokens = integer(raw.output_tokens)
  const reasoning = integer(object(raw.output_tokens_details)?.thinking_tokens)
  const inputTokens =
    uncached === undefined && cacheRead === undefined && cacheWrite === undefined
      ? undefined
      : (uncached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(uncached === undefined ? {} : { uncachedInputTokens: uncached }),
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
    ...(cacheWrite5m === undefined ? {} : { cacheWrite5mInputTokens: cacheWrite5m }),
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1hInputTokens: cacheWrite1h }),
    ...(outputTokens === undefined
      ? {}
      : { textOutputTokens: Math.max(0, outputTokens - (reasoning ?? 0)) }),
    ...(reasoning === undefined ? {} : { reasoningOutputTokens: reasoning }),
    raw,
  }
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
    code = string(error?.type) || undefined
  } catch {
    // Arbitrary HTML/text bodies stay private; status is enough for the public error.
  }
  return new ModelProviderError(`[SixbAnthropic] ${message}`, providerId, modelId, {
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
  const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id")
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

function anthropicHeaders(
  transport: AnthropicTransport,
  accept: string,
  contentType = false
): Record<string, string> {
  const headers = resolve(transport.headers) ?? {}
  const apiKey = resolve(transport.apiKey)
  const betas = resolve(transport.betas)?.filter((value) => value.trim()) ?? []
  return {
    accept,
    ...headers,
    "anthropic-version": transport.apiVersion,
    ...(contentType ? { "content-type": "application/json" } : {}),
    ...(betas.length === 0 ? {} : { "anthropic-beta": betas.join(",") }),
    ...(apiKey ? { "x-api-key": apiKey } : {}),
  }
}

function resolve<T>(source: ValueSource<T> | undefined): T | undefined {
  return typeof source === "function" ? (source as () => T)() : source
}

function supported(capabilities: JsonObject | undefined, name: string): boolean {
  return object(capabilities?.[name])?.supported === true
}

function anthropicReasoningCapabilities(
  capabilities: JsonObject | undefined
): false | ModelReasoningCapabilities | undefined {
  if (capabilities === undefined) return undefined
  if (!supported(capabilities, "thinking")) return false

  const effortCapabilities = object(capabilities.effort)
  const efforts = MODEL_REASONING_EFFORTS.filter((effort) => supported(effortCapabilities, effort))
  const thinkingTypes = object(object(capabilities.thinking)?.types)
  const supportsManualBudget = supported(thinkingTypes, "enabled")
  return {
    canDisable: true,
    ...(efforts.length === 0 ? {} : { efforts }),
    ...(supportsManualBudget ? { budgetTokens: { min: 1_024 } } : {}),
  }
}

function requiredIndex(value: unknown, label: string): number {
  const index = integer(value)
  if (index === undefined) throw new TypeError(`[SixbAnthropic] ${label} index is invalid.`)
  return index
}

function date(value: string): string {
  if (!value) return ""
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? "" : parsed.toISOString().slice(0, 10)
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

function positiveInteger(value: unknown): number | undefined {
  const parsed = integer(value)
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}

function assertNonnegativeInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`[SixbAnthropic] ${field} must be a nonnegative integer.`)
  }
}

function assertPositiveIntegerOption(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`[SixbAnthropic] ${field} must be a positive integer.`)
  }
}
