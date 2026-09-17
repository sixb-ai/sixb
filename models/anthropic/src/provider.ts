import {
  assertJsonObject,
  defineLanguageModel,
  estimateModelReservation,
  isJsonObject,
  isModelReasoning,
  type JsonObject,
  type LanguageModel,
  type LanguageModelDefinition,
  type LanguageModelDefinitionCatalog,
  type LanguageModelProvider,
  type LanguageModelRequest,
  MODEL_REASONING_EFFORTS,
  type ModelCapabilities,
  ModelCatalogUnavailableError,
  type ModelCostEstimator,
  ModelProviderError,
  type ModelReasoningCapabilities,
  type ModelReasoningEffort,
  modelReasoningSupportIssue,
  rateModelCall,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import { messagesEvents, messagesInput } from "@sixb/model-protocols/messages"
import { anthropicMaxOutputTokens, anthropicRateCard } from "./model-details"
import { anthropicOutputSchema } from "./structured-output"

type ValueSource<T> = T | (() => T)

const PROVIDER_ID = "anthropic"
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
const DEFAULT_API_VERSION = "2023-06-01"
const CATALOG_TIMEOUT_MS = 5_000
const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1_000
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000
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

export interface AnthropicCatalog extends LanguageModelDefinitionCatalog {
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
  const transport: AnthropicTransport = {
    ...options,
    apiKey: options.apiKey ?? (() => process.env.ANTHROPIC_API_KEY),
    baseUrl,
    apiVersion,
  }
  const configuredModels = configuredModelDefinitions(options.models ?? [])
  const catalog = new RemoteAnthropicCatalog(transport, configuredModels)
  const model = (modelId: string, modelOptions: AnthropicModelOptions = {}) => {
    if (!modelId.trim()) throw new TypeError("[SixbAnthropic] Model id must not be empty.")
    return new AnthropicLanguageModel(
      transport,
      catalog,
      modelId,
      structuredClone(modelOptions),
      configuredModels.get(modelId)
    )
  }
  return Object.assign(model, {
    providerId: PROVIDER_ID as typeof PROVIDER_ID,
    catalog,
  })
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
    if (this.loadPromise && this.loadedAt !== 0 && Date.now() - this.loadedAt >= ttl) {
      this.loadPromise = undefined
      this.loadedAt = 0
    }
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
      }).catch((cause: unknown) => {
        throw new ModelCatalogUnavailableError("[SixbAnthropic] Model catalog unavailable.", {
          cause,
        })
      })
      if (!response.ok) {
        throw new ModelCatalogUnavailableError("[SixbAnthropic] Model catalog unavailable.", {
          cause: await providerHttpError(response, PROVIDER_ID, "catalog").catch(
            (cause: unknown) => cause
          ),
        })
      }
      const raw = await response.text().catch((cause: unknown) => {
        throw new ModelCatalogUnavailableError("[SixbAnthropic] Model catalog unavailable.", {
          cause,
        })
      })
      const body: unknown = JSON.parse(raw)
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
  const maxInputTokens = positiveInteger(model?.max_input_tokens)
  const maxOutputTokens = positiveInteger(model?.max_tokens)
  const providerTools = ["code_execution", "web_search", "web_fetch"].some((name) =>
    supported(capabilities, name)
  )
  const reasoning = anthropicReasoningCapabilities(capabilities, modelId)
  return defineLanguageModel({
    kind: "language",
    providerId: PROVIDER_ID,
    modelId,
    ...(name ? { name } : {}),
    family: "Claude",
    ...(releaseDate ? { releaseDate } : {}),
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    capabilities: {
      ...(inputMediaTypes.length === 0 ? {} : { inputMediaTypes }),
      ...(reasoning === undefined ? {} : { reasoning }),
      localTools: true,
      parallelToolCalls: true,
      ...(supported(capabilities, "structured_outputs") ? { nativeStructuredOutput: true } : {}),
      ...(providerTools ? { providerExecutedTools: true } : {}),
    },
  })
}

function fallbackDefinition(modelId: string): LanguageModelDefinition {
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
  })
}

class AnthropicLanguageModel implements LanguageModel {
  readonly providerId = PROVIDER_ID
  readonly modelId: string
  readonly definition: LanguageModelDefinition
  readonly costEstimator: ModelCostEstimator
  private readonly maxOutputTokens: number

  constructor(
    private readonly transport: AnthropicTransport,
    private readonly catalog: AnthropicCatalog,
    modelId: string,
    private readonly options: AnthropicModelOptions,
    configuredDefinition: LanguageModelDefinition | undefined,
    private readonly metadataResolved = false
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
    // Server tools may add request- or duration-based charges that token rates cannot represent.
    const rateCard =
      (options.providerTools?.length ?? 0) > 0
        ? undefined
        : anthropicRateCard(modelId, options.request)
    this.definition = defineLanguageModel({
      ...base,
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    })
    this.costEstimator = {
      estimateReservation: (tokens) => estimateModelReservation({ ...tokens, rateCard }),
      estimate: ({ usage }) => rateModelCall({ usage, rateCard }),
    }
  }

  async resolve(options?: { readonly offline?: boolean }): Promise<LanguageModel> {
    if (this.metadataResolved) return this
    const definition = options?.offline ? this.definition : await this.catalog.get(this.modelId)
    return new AnthropicLanguageModel(
      this.transport,
      this.catalog,
      this.modelId,
      this.options,
      definition ?? this.definition,
      true
    )
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
      events: messagesEvents(response.body, request.signal, {
        providerId: this.providerId,
        modelId: this.modelId,
        requestId: requestId ?? undefined,
        errorPrefix: "[SixbAnthropic]",
      }),
    }
  }

  private async prepareRequest(request: LanguageModelRequest): Promise<{
    readonly body: JsonObject
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
    const mapped = messagesInput(request.messages, this.providerId, "[SixbAnthropic]")
    const nativeOutputSchema =
      request.responseFormat !== undefined && (await this.supportsNativeStructuredOutput())
        ? anthropicOutputSchema(request.responseFormat.schema)
        : undefined
    if (request.responseFormat !== undefined && nativeOutputSchema === undefined) {
      throw new UnsupportedModelFeatureError(
        `[SixbAnthropic] Structured output requires native support for model '${this.modelId}' and the supplied schema. Choose a supported model and schema; JSON-tool fallback is not supported.`
      )
    }
    const tools: JsonObject[] = [
      ...(this.options.providerTools ?? []),
      ...request.tools.map((tool) => {
        const schema = anthropicOutputSchema(tool.inputSchema)
        return {
          name: tool.name,
          description: tool.description,
          input_schema: schema ?? tool.inputSchema,
          strict: schema !== undefined,
        }
      }),
    ]
    const existingOutputConfig = object(extra.output_config)
    if (extra.output_config !== undefined && !existingOutputConfig) {
      throw new TypeError("[SixbAnthropic] Model request option 'output_config' must be an object.")
    }
    if (existingOutputConfig?.format !== undefined) {
      throw new TypeError(
        "[SixbAnthropic] Model request option 'output_config.format' is owned by the adapter."
      )
    }
    if (
      request.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)
    ) {
      throw new TypeError("[SixbAnthropic] maxOutputTokens must be a positive safe integer.")
    }
    const maxOutputTokens = Math.min(
      request.maxOutputTokens ?? this.maxOutputTokens,
      this.maxOutputTokens
    )
    const reasoning = anthropicReasoningRequest(
      request.reasoning,
      this.definition.capabilities.reasoning,
      maxOutputTokens,
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
        max_tokens: maxOutputTokens,
        ...(mapped.system.length === 0 ? {} : { system: mapped.system }),
        ...(tools.length === 0
          ? {}
          : {
              tools,
              tool_choice: { type: "auto" },
            }),
        ...(Object.keys(outputConfig).length === 0 ? {} : { output_config: outputConfig }),
        ...(reasoning.thinking === undefined ? {} : { thinking: reasoning.thinking }),
      },
    }
  }

  private async supportsNativeStructuredOutput(): Promise<boolean> {
    const declared = this.definition.capabilities.nativeStructuredOutput
    if (declared !== undefined) return declared
    try {
      return (
        !this.metadataResolved &&
        (await this.catalog.get(this.modelId))?.capabilities.nativeStructuredOutput === true
      )
    } catch {
      return false
    }
  }
}

function anthropicReasoningRequest(
  reasoning: LanguageModelRequest["reasoning"],
  capabilities: ModelCapabilities["reasoning"],
  maxOutputTokens: number,
  modelId: string
): { readonly effort?: ModelReasoningEffort; readonly thinking?: JsonObject } {
  const issue =
    reasoning === "none" && anthropicThinkingAlwaysOn(modelId)
      ? "reasoning cannot be disabled"
      : modelReasoningSupportIssue(capabilities, reasoning)
  if (issue) {
    if (typeof reasoning === "string" && isModelReasoning(reasoning)) {
      console.warn(
        `[SixbAnthropic] Model '${modelId}' ${issue}. Using provider-default reasoning instead.`
      )
      return {}
    }
    throw new UnsupportedModelFeatureError(`[SixbAnthropic] Model '${modelId}' ${issue}.`)
  }
  if (reasoning === undefined || reasoning === "provider-default") return {}
  if (reasoning === "none") return { thinking: { type: "disabled" } }
  if (typeof reasoning === "string") {
    if (reasoning === "minimal") {
      console.warn(
        `[SixbAnthropic] Model '${modelId}' does not support reasoning effort 'minimal'. Using provider-default reasoning instead.`
      )
      return {}
    }
    // These adaptive-capable models default to thinking off; effort alone does not enable it.
    // Claude 5 models already enable thinking by default, and earlier models use manual budgets.
    const enableAdaptive = /^claude-(?:opus-4-[678]|sonnet-4-6)(?:-|$)/.test(modelId)
    return {
      effort: reasoning,
      ...(enableAdaptive ? { thinking: { type: "adaptive" } } : {}),
    }
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

// The catalog exposes adaptive/manual support, but not whether thinking can be disabled.
// Keep the same restriction for direct and offline bindings that have no catalog metadata.
function anthropicThinkingAlwaysOn(modelId: string): boolean {
  return /^claude-(?:fable-5|mythos-(?:5|preview))(?:-|$)/.test(modelId)
}

function anthropicReasoningCapabilities(
  capabilities: JsonObject | undefined,
  modelId: string
): false | ModelReasoningCapabilities | undefined {
  if (capabilities === undefined) return undefined
  if (!supported(capabilities, "thinking")) return false

  const effortCapabilities = object(capabilities.effort)
  const efforts = MODEL_REASONING_EFFORTS.filter((effort) => supported(effortCapabilities, effort))
  const thinkingTypes = object(object(capabilities.thinking)?.types)
  const supportsManualBudget = supported(thinkingTypes, "enabled")
  return {
    canDisable: !anthropicThinkingAlwaysOn(modelId),
    ...(efforts.length === 0 ? {} : { efforts }),
    ...(supportsManualBudget ? { budgetTokens: { min: 1_024 } } : {}),
  }
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
