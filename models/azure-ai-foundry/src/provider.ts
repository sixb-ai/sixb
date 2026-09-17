import {
  assertJsonObject,
  defineLanguageModel,
  type JsonObject,
  type LanguageModel,
  type LanguageModelDefinition,
  type LanguageModelProvider,
  type LanguageModelRateCard,
  type LanguageModelRequest,
  type LanguageModelStream,
  type LanguageModelStreamEvent,
  type ModelCostEstimator,
  ModelProviderError,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import { chatEvents } from "@sixb/model-protocols/chat"
import { messagesEvents } from "@sixb/model-protocols/messages"
import { responsesEvents } from "@sixb/model-protocols/responses"
import { foundryEstimator, foundryUsage } from "./accounting"
import { type AzureAIFoundryCatalogOptions, RemoteModelsDevCatalog } from "./catalog"
import { foundryChatEstimator, foundryChatUsage } from "./chat-accounting"
import { type ChatRequestOptions, foundryChatRequest, validateChatOptions } from "./chat-request"
import {
  type AzureAIFoundryCatalog,
  type AzureAIFoundryDeployment,
  type AzureAIFoundryDiscoveryOptions,
  FoundryDeployments,
  type ResolvedDeployment,
} from "./discovery"
import { foundryMessagesEstimator, foundryMessagesUsage } from "./messages-accounting"
import {
  foundryMessagesRequest,
  type MessagesRequestOptions,
  validateMessagesOptions,
} from "./messages-request"
import { type RequestOptions, responsesRequest, validateOptions } from "./request"
import { resolveModel } from "./resolution"
import {
  abortable,
  type FoundryProtocol,
  FoundryTransport,
  requestId,
  type TransportOptions,
} from "./transport"
import { object, PREFIX } from "./util"

export interface AzureAIFoundryOptions extends TransportOptions {
  /** Lazy public model/price discovery. Set false for fully explicit bindings. */
  readonly catalog?: AzureAIFoundryCatalogOptions | false
  /** Namespace bindings from different resources/projects in a single Sixb catalog. */
  readonly providerId?: string
  readonly models?: readonly LanguageModelDefinition[]
  /** Automatic for Entra project endpoints. Set false for explicitly configured/offline bindings. */
  readonly discovery?: AzureAIFoundryDiscoveryOptions | false
}

export interface AzureAIFoundryModelMetadata {
  readonly publisher?: string
  readonly modelName?: string
  readonly modelVersion?: string
  readonly sku?: string
  readonly catalog?: {
    readonly provider: "azure" | "fireworks-ai"
    readonly modelId: string
    readonly source: string
    readonly pricing: "reference"
  }
  /** Optional hosting identity; does not select capabilities or reference prices. */
  readonly hosting?: "azure" | "anthropic"
  readonly deployment?: AzureAIFoundryDeployment
  readonly discoveredAt?: string
}

export interface AzureAIFoundryModelOptions extends RequestOptions {
  readonly definition?: Omit<LanguageModelDefinition, "kind" | "providerId" | "modelId">
  readonly metadata?: Pick<
    AzureAIFoundryModelMetadata,
    "publisher" | "modelName" | "modelVersion" | "hosting" | "sku"
  >
  readonly rateCard?: LanguageModelRateCard
  readonly costEstimator?: ModelCostEstimator
  /** Default: preserve positive reports; trust zero only for OpenAI. "unknown" omits all reasoning counts. */
  readonly reasoningUsage?: "reported" | "unknown"
}

export interface AzureAIFoundryMessagesOptions extends MessagesRequestOptions {
  readonly definition?: AzureAIFoundryModelOptions["definition"]
  readonly metadata?: AzureAIFoundryModelOptions["metadata"]
  readonly rateCard?: LanguageModelRateCard
  readonly costEstimator?: ModelCostEstimator
}

export interface AzureAIFoundryChatOptions extends ChatRequestOptions {
  readonly definition?: AzureAIFoundryModelOptions["definition"]
  readonly metadata?: AzureAIFoundryModelOptions["metadata"]
  readonly rateCard?: LanguageModelRateCard
  readonly costEstimator?: ModelCostEstimator
  readonly reasoningUsage?: "reported" | "unknown"
}

export interface AzureAIFoundryModel<Protocol extends FoundryProtocol = FoundryProtocol>
  extends LanguageModel {
  readonly protocol: Protocol
  readonly metadata: AzureAIFoundryModelMetadata
  readonly costEstimator: ModelCostEstimator
  resolve(options?: { readonly offline?: boolean }): Promise<AzureAIFoundryModel<Protocol>>
}

export interface AzureAIFoundryProvider extends LanguageModelProvider {
  (deploymentName: string, options?: AzureAIFoundryModelOptions): AzureAIFoundryModel
  responses(
    deploymentName: string,
    options?: AzureAIFoundryModelOptions
  ): AzureAIFoundryModel<"responses">
  messages(
    deploymentName: string,
    options?: AzureAIFoundryMessagesOptions
  ): AzureAIFoundryModel<"messages">
  readonly catalog: AzureAIFoundryCatalog
  chat(deploymentName: string, options?: AzureAIFoundryChatOptions): AzureAIFoundryModel<"chat">
}

export function createAzureAIFoundry(options: AzureAIFoundryOptions): AzureAIFoundryProvider {
  const transport = new FoundryTransport(options)
  const providerId = options.providerId ?? "azure-ai-foundry"
  if (!providerId.trim()) throw new TypeError(`${PREFIX} providerId must not be empty.`)
  const definitions = new Map<string, LanguageModelDefinition>()
  for (const input of options.models ?? []) {
    const definition = defineLanguageModel(input)
    if (definition.providerId !== providerId)
      throw new TypeError(`${PREFIX} Supplied definitions must use providerId '${providerId}'.`)
    if (definitions.has(definition.modelId))
      throw new TypeError(`${PREFIX} Duplicate deployment '${definition.modelId}'.`)
    definitions.set(definition.modelId, definition)
  }
  const deployments = new FoundryDeployments(
    providerId,
    transport.baseUrl,
    options,
    options.discovery === false
      ? undefined
      : (options.discovery ?? (transport.project && options.tokenProvider ? {} : undefined))
  )
  const modelCatalog = new RemoteModelsDevCatalog(options.catalog)
  const model = <P extends FoundryProtocol = FoundryProtocol>(
    protocol: P | undefined,
    deploymentName: string,
    modelOptions: AzureAIFoundryModelOptions & MessagesRequestOptions & ChatRequestOptions
  ) => {
    if (!deploymentName.trim() || deploymentName !== deploymentName.trim())
      throw new TypeError(
        `${PREFIX} deploymentName must be nonempty without surrounding whitespace.`
      )
    return new FoundryModel(
      protocol,
      transport,
      deployments,
      providerId,
      deploymentName,
      modelOptions,
      {},
      definitions.get(deploymentName),
      modelCatalog
    )
  }
  const responses = (name: string, options: AzureAIFoundryModelOptions = {}) =>
    model("responses", name, options)
  const messages = (name: string, options: AzureAIFoundryMessagesOptions = {}) =>
    model("messages", name, options)
  const chat = (name: string, options: AzureAIFoundryChatOptions = {}) =>
    model("chat", name, options)
  const list = async (protocol?: FoundryProtocol, refresh = false) => {
    if (refresh) modelCatalog.invalidate()
    const records = await deployments.list(refresh)
    const names = new Set([...records.map((d) => d.name), ...definitions.keys()])
    const results: LanguageModelDefinition[] = []
    for (const name of names) {
      const deployment = records.find((d) => d.name === name)
      try {
        const profile = resolveModel({
          providerId,
          modelId: name,
          protocol,
          options: {},
          supplied: definitions.get(name),
          deployment,
          catalogModel: await modelCatalog.get(deployment?.modelName),
        })
        const flags = deployment?.capabilities
        const supported =
          profile.metadata.catalog ||
          definitions.has(name) ||
          (profile.protocol === "responses"
            ? flags?.responses === "true"
            : profile.protocol === "chat"
              ? flags?.chatCompletion === "true" || flags?.chat_completion === "true"
              : flags?.messages === "true")
        if (supported) results.push(profile.definition)
      } catch (error) {
        if (!(error instanceof UnsupportedModelFeatureError)) throw error
      }
    }
    return Object.freeze(results)
  }
  const catalog: AzureAIFoundryCatalog = {
    get: async (name, options) => (await list(options?.protocol)).find((d) => d.modelId === name),
    list: (options) => list(options?.protocol),
    refresh: (options) => list(options?.protocol, true),
    deployments: () => deployments.list(),
  }
  const auto = (name: string, options: AzureAIFoundryModelOptions = {}) =>
    model(undefined, name, options)
  return Object.assign(auto, { providerId, catalog, responses, messages, chat })
}

class FoundryModel<Protocol extends FoundryProtocol> implements AzureAIFoundryModel<Protocol> {
  private readonly profile: ReturnType<typeof resolveModel>
  private readonly estimator: ModelCostEstimator
  #execution?: FoundryModel<Protocol>
  #pendingExecution?: Promise<FoundryModel<Protocol>>
  get protocol(): Protocol {
    return (this.#execution?.profile.protocol ?? this.profile.protocol) as Protocol
  }
  get definition() {
    return this.#execution?.profile.definition ?? this.profile.definition
  }
  get metadata() {
    return this.#execution?.profile.metadata ?? this.profile.metadata
  }
  get costEstimator() {
    return this.#execution?.estimator ?? this.estimator
  }
  private readonly options: AzureAIFoundryModelOptions & MessagesRequestOptions & ChatRequestOptions
  private readonly scope: string
  private readonly reliableReasoning: boolean | undefined

  constructor(
    private readonly requestedProtocol: Protocol | undefined,
    private readonly transport: FoundryTransport,
    private readonly deployments: FoundryDeployments,
    readonly providerId: string,
    readonly modelId: string,
    options: AzureAIFoundryModelOptions & MessagesRequestOptions & ChatRequestOptions,
    resolution: ResolvedDeployment,
    private readonly supplied?: LanguageModelDefinition,
    private readonly modelCatalog?: RemoteModelsDevCatalog,
    private readonly resolved = false
  ) {
    if (options.request !== undefined)
      assertJsonObject(options.request, `${PREFIX} request options`)
    if (options.rateCard && options.costEstimator)
      throw new TypeError(`${PREFIX} Configure either rateCard or costEstimator, not both.`)
    if (
      options.reasoningUsage !== undefined &&
      !["reported", "unknown"].includes(options.reasoningUsage)
    )
      throw new TypeError(`${PREFIX} Invalid reasoningUsage.`)
    const explicitMetadata = { ...options.metadata }
    for (const value of Object.values(explicitMetadata)) {
      if (typeof value !== "string" || !value.trim())
        throw new TypeError(`${PREFIX} Metadata values must be nonempty strings.`)
    }
    this.profile = resolveModel({
      providerId,
      modelId,
      protocol: requestedProtocol,
      options,
      supplied,
      ...resolution,
    })
    const protocol = this.profile.protocol
    transport.url(protocol)
    if (protocol === "messages") validateMessagesOptions(options)
    else if (protocol === "chat") validateChatOptions(options)
    else validateOptions(options)
    if (
      this.metadata.hosting !== undefined &&
      !["azure", "anthropic"].includes(this.metadata.hosting)
    )
      throw new TypeError(`${PREFIX} Invalid hosting; use azure or anthropic.`)
    const { costEstimator, ...serializable } = options
    this.options = {
      ...structuredClone({ ...serializable, metadata: explicitMetadata }),
      ...(costEstimator ? { costEstimator } : {}),
    }
    this.scope = JSON.stringify([
      protocol === "messages" ? transport.url(protocol) : transport.baseUrl,
      this.protocol,
      modelId,
    ])
    this.reliableReasoning =
      options.reasoningUsage === "unknown"
        ? false
        : options.reasoningUsage === "reported" ||
            this.metadata.publisher?.toLowerCase() === "openai"
          ? true
          : undefined
    this.estimator =
      options.costEstimator ??
      (protocol === "messages"
        ? foundryMessagesEstimator
        : protocol === "chat"
          ? foundryChatEstimator
          : foundryEstimator)(
        this.profile.rateCard,
        this.options.request,
        this.metadata.modelName,
        this.metadata.modelVersion,
        this.profile.aliases
      )
    Object.freeze(this)
  }

  async resolve(options?: { readonly offline?: boolean }): Promise<FoundryModel<Protocol>> {
    if (
      this.resolved ||
      (!this.deployments.enabled &&
        (!this.modelCatalog?.enabled || !this.options.metadata?.modelName))
    )
      return this
    const resolution = await this.deployments.resolve(this.modelId, options?.offline === true)
    return new FoundryModel(
      this.requestedProtocol,
      this.transport,
      this.deployments,
      this.providerId,
      this.modelId,
      this.options,
      {
        ...resolution,
        catalogModel: await this.modelCatalog?.get(
          resolution.deployment?.modelName ?? this.options.metadata?.modelName,
          options?.offline
        ),
      },
      this.supplied,
      this.modelCatalog,
      true
    )
  }

  async stream(request: LanguageModelRequest): Promise<LanguageModelStream> {
    request.signal.throwIfAborted()
    if (
      !this.resolved &&
      (this.deployments.enabled || (this.modelCatalog?.enabled && this.options.metadata?.modelName))
    ) {
      // A direct-stream handle pins its first execution too. Workers use resolve() before admission.
      this.#pendingExecution ??= this.resolve()
        .then((model) => {
          this.#execution = model
          return model
        })
        .catch((error) => {
          this.#pendingExecution = undefined
          throw error
        })
      const model = await abortable(() => this.#pendingExecution!, request.signal)
      return model.stream(request)
    }
    const body =
      this.protocol === "messages"
        ? foundryMessagesRequest(request, this.definition, this.options, this.scope)
        : this.protocol === "chat"
          ? foundryChatRequest(request, this.definition, this.options, this.scope)
          : responsesRequest(
              request,
              this.definition,
              this.options,
              this.transport.project,
              this.scope
            )
    const response = await this.transport.post(
      JSON.stringify(body),
      request.signal,
      this.providerId,
      this.modelId,
      this.protocol
    )
    const id = this.transport.redactText(response, requestId(response))
    if (!response.body)
      throw new ModelProviderError(
        `${PREFIX} Provider returned an empty streaming response.`,
        this.providerId,
        this.modelId,
        { requestId: id, status: response.status }
      )
    const streamOptions = {
      providerId: this.providerId,
      modelId: this.modelId,
      requestId: id,
      errorPrefix: PREFIX,
    }
    return {
      events: this.events(
        this.protocol === "messages"
          ? messagesEvents(response.body, request.signal, {
              ...streamOptions,
              usage: foundryMessagesUsage,
            })
          : this.protocol === "chat"
            ? chatEvents(response.body, request.signal, {
                ...streamOptions,
                usage: (raw) => foundryChatUsage(raw, this.reliableReasoning),
              })
            : responsesEvents(response.body, request.signal, {
                ...streamOptions,
                usage: (raw) => foundryUsage(raw, this.reliableReasoning),
                finishMetadata: (response) => {
                  const metadata: JsonObject = {}
                  for (const key of [
                    "content_filters",
                    "prompt_filter_results",
                    "incomplete_details",
                  ]) {
                    if (response[key] !== undefined) metadata[key] = response[key]
                  }
                  return {
                    providerData: { [this.providerId]: metadata },
                    ...(typeof response.model === "string"
                      ? { route: { modelId: response.model } }
                      : {}),
                  }
                },
              }),
        response
      ),
    }
  }

  private async *events(
    source: AsyncIterable<LanguageModelStreamEvent>,
    response: Response
  ): AsyncIterable<LanguageModelStreamEvent> {
    try {
      for await (const event of source) {
        if (event.type === "error" && event.error instanceof ModelProviderError) {
          yield { ...event, error: this.transport.redactError(response, event.error) }
        } else if (event.type === "provider-state" && event.providerId === this.providerId) {
          yield { ...event, data: { ...object(event.data), scope: this.scope } }
        } else if ("providerData" in event && event.providerData?.[this.providerId]) {
          yield {
            ...event,
            providerData: {
              ...event.providerData,
              [this.providerId]: {
                ...object(event.providerData[this.providerId]),
                scope: this.scope,
              },
            },
          }
        } else yield event
      }
    } catch (error) {
      throw this.transport.redactFailure(response, error)
    }
  }
}
