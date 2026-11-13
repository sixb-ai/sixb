import {
  assertJsonObject,
  type JsonObject,
  type LanguageModel,
  type LanguageModelDefinition,
  type LanguageModelLabel,
  type LanguageModelProvider,
  type LanguageModelRequest,
  type LanguageModelStream,
  type LanguageModelStreamEvent,
  MODEL_REASONING_LEVELS,
  ModelCatalogUnavailableError,
  type ModelCostEstimator,
  ModelProviderError,
  type ModelRateCard,
  type ModelReasoningLevel,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import { chatEvents } from "@sixb/model-protocols/chat"
import { isStrictToolLimitError, messagesEvents } from "@sixb/model-protocols/messages"
import { responsesEvents } from "@sixb/model-protocols/responses"
import { foundryEstimator, foundryUsage, type PricedEstimator } from "./accounting"
import {
  type AzureAIFoundryCatalogOptions,
  type CatalogModel,
  RemoteModelsDevCatalog,
} from "./catalog"
import { foundryChatEstimator, foundryChatUsage } from "./chat-accounting"
import { type ChatRequestOptions, foundryChatRequest, validateChatOptions } from "./chat-request"
import {
  type AzureAIFoundryDecisionModel,
  type AzureAIFoundryDecisionOptions,
  createFoundryDecision,
} from "./decision"
import {
  type AzureAIFoundryCatalog,
  type AzureAIFoundryDeployment,
  type AzureAIFoundryDiscoveryOptions,
  FoundryDeployments,
  type ResolvedDeployment,
} from "./discovery"
import {
  type AzureAIFoundryEmbeddingModel,
  type AzureAIFoundryEmbeddingOptions,
  type AzureAIFoundryEmbeddingTransportOptions,
  createFoundryEmbedding,
} from "./embedding"
import { deploymentKind, KIND_BINDINGS } from "./kinds"
import { foundryMessagesEstimator, foundryMessagesUsage } from "./messages-accounting"
import {
  foundryMessagesRequest,
  type MessagesRequestOptions,
  strictToolRefusals,
  validateMessagesOptions,
} from "./messages-request"
import { type RequestOptions, responsesRequest, validateOptions } from "./request"
import {
  type AzureAIFoundryRerankingModel,
  type AzureAIFoundryRerankingOptions,
  createFoundryReranking,
} from "./reranking"
import { resolveModel } from "./resolution"
import {
  type AzureAIFoundrySpeechModel,
  type AzureAIFoundrySpeechOptions,
  createFoundrySpeech,
} from "./speech"
import {
  type AzureAIFoundryTranscriptionModel,
  type AzureAIFoundryTranscriptionOptions,
  createFoundryTranscription,
} from "./transcription"
import {
  abortable,
  type FoundryProtocol,
  FoundryTransport,
  requestId,
  type TransportOptions,
} from "./transport"
import { object, PREFIX } from "./util"

export interface AzureAIFoundryOptions extends TransportOptions {
  /** Explicit resource transport: project endpoints do not route embeddings. */
  readonly embeddings?: AzureAIFoundryEmbeddingTransportOptions
  /** Public model capabilities and reference pricing from models.dev. */
  readonly catalog?: AzureAIFoundryCatalogOptions
  /** Namespace bindings from different resources/projects in a single Sixb catalog. */
  readonly providerId?: string
  /** Required project deployment lookup: cache lifetime and request bounds. */
  readonly discovery?: AzureAIFoundryDiscoveryOptions
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
  readonly deployment?: AzureAIFoundryDeployment
  readonly discoveredAt?: string
}

export interface AzureAIFoundryModelOptions extends RequestOptions, LanguageModelLabel {
  /** Reasoning Sixb applies when this model runs without an explicit choice. */
  readonly reasoning?: ModelReasoningLevel
  readonly definition?: Omit<LanguageModelDefinition, "kind" | "providerId" | "modelId">
  readonly rateCard?: ModelRateCard
  readonly costEstimator?: ModelCostEstimator
  /** Default: preserve positive reports; trust zero only for OpenAI. "unknown" omits all reasoning counts. */
  readonly reasoningUsage?: "reported" | "unknown"
}

export interface AzureAIFoundryMessagesOptions extends MessagesRequestOptions, LanguageModelLabel {
  readonly reasoning?: ModelReasoningLevel
  readonly definition?: AzureAIFoundryModelOptions["definition"]
  readonly rateCard?: ModelRateCard
  readonly costEstimator?: ModelCostEstimator
}

export interface AzureAIFoundryChatOptions extends ChatRequestOptions, LanguageModelLabel {
  readonly reasoning?: ModelReasoningLevel
  readonly definition?: AzureAIFoundryModelOptions["definition"]
  readonly rateCard?: ModelRateCard
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
  embedding(
    deploymentName: string,
    options: AzureAIFoundryEmbeddingOptions
  ): AzureAIFoundryEmbeddingModel
  /** A deployment of a decision model, such as Microsoft-Decision-1, for `models.decision`. */
  decision(
    deploymentName: string,
    options?: AzureAIFoundryDecisionOptions
  ): AzureAIFoundryDecisionModel
  /** A transcription deployment, such as gpt-4o-transcribe, for `models.audio.transcription`. */
  transcription(
    deploymentName: string,
    options?: AzureAIFoundryTranscriptionOptions
  ): AzureAIFoundryTranscriptionModel
  /** A Cohere rerank deployment, such as Cohere-rerank-v5-fast, for `models.reranking`. */
  reranking(
    deploymentName: string,
    options?: AzureAIFoundryRerankingOptions
  ): AzureAIFoundryRerankingModel
  /** A speech deployment, such as gpt-4o-mini-tts, for `models.audio.speech`. */
  speech(deploymentName: string, options?: AzureAIFoundrySpeechOptions): AzureAIFoundrySpeechModel
  readonly catalog: AzureAIFoundryCatalog
  chat(deploymentName: string, options?: AzureAIFoundryChatOptions): AzureAIFoundryModel<"chat">
}

export function createAzureAIFoundry(options: AzureAIFoundryOptions): AzureAIFoundryProvider {
  const transport = new FoundryTransport(options)
  const providerId = options.providerId ?? "azure-ai-foundry"
  if (!providerId.trim()) throw new TypeError(`${PREFIX} providerId must not be empty.`)
  const deployments = new FoundryDeployments(providerId, transport, options.discovery)
  const modelCatalog = new RemoteModelsDevCatalog(options.catalog)
  const embeddingTransport = options.embeddings
    ? new FoundryTransport(options.embeddings, "resource")
    : undefined
  const embedding = (name: string, input: AzureAIFoundryEmbeddingOptions) => {
    if (!embeddingTransport)
      throw new TypeError(
        `${PREFIX} Configure embeddings.endpoint and embeddings.apiKey before declaring an embedding model.`
      )
    return createFoundryEmbedding(
      providerId,
      name,
      input,
      embeddingTransport,
      deployments,
      modelCatalog
    )
  }
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
      modelCatalog
    )
  }
  const responses = (name: string, options: AzureAIFoundryModelOptions = {}) =>
    model("responses", name, options)
  const messages = (name: string, options: AzureAIFoundryMessagesOptions = {}) =>
    model("messages", name, options)
  const chat = (name: string, options: AzureAIFoundryChatOptions = {}) =>
    model("chat", name, options)
  const decision = (name: string, options: AzureAIFoundryDecisionOptions = {}) =>
    createFoundryDecision(providerId, name, options, transport, deployments)
  const transcription = (name: string, options: AzureAIFoundryTranscriptionOptions = {}) =>
    createFoundryTranscription(providerId, name, options, transport, deployments)
  const reranking = (name: string, options: AzureAIFoundryRerankingOptions = {}) =>
    createFoundryReranking(providerId, name, options, transport, deployments)
  const speech = (name: string, options: AzureAIFoundrySpeechOptions = {}) =>
    createFoundrySpeech(providerId, name, options, transport, deployments)
  const list = async (protocol?: FoundryProtocol, refresh = false) => {
    if (refresh) modelCatalog.invalidate()
    const records = await deployments.list(refresh)
    const lookup = records.length ? await modelCatalog.lookup() : undefined
    const results: LanguageModelDefinition[] = []
    for (const deployment of records) {
      const name = deployment.name
      // Listings hold language models; every other kind has its own binding.
      if (
        deploymentKind(deployment) !== "language" ||
        (await modelCatalog.getEmbedding(deployment.modelName, true))
      )
        continue
      try {
        const profile = resolveModel({
          providerId,
          modelId: name,
          protocol,
          options: {},
          deployment,
          catalogModel: lookup?.(deployment.modelName),
        })
        const flags = deployment.capabilities
        const supported =
          profile.metadata.catalog ||
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
  return Object.assign(auto, {
    providerId,
    catalog,
    responses,
    messages,
    chat,
    embedding,
    decision,
    transcription,
    reranking,
    speech,
  })
}

class FoundryModel<Protocol extends FoundryProtocol> implements AzureAIFoundryModel<Protocol> {
  private readonly profile: ReturnType<typeof resolveModel>
  private readonly estimator: PricedEstimator
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
  /** The card the estimator prices by; none with a custom costEstimator or unpriced options. */
  get rateCard() {
    return (this.#execution?.estimator ?? this.estimator).rateCard
  }
  private readonly options: AzureAIFoundryModelOptions & MessagesRequestOptions & ChatRequestOptions
  private readonly scope: string
  private readonly reliableReasoning: boolean | undefined
  readonly defaultReasoning?: ModelReasoningLevel
  readonly maxOutputTokens?: number

  constructor(
    private readonly requestedProtocol: Protocol | undefined,
    private readonly transport: FoundryTransport,
    private readonly deployments: FoundryDeployments,
    readonly providerId: string,
    readonly modelId: string,
    options: AzureAIFoundryModelOptions & MessagesRequestOptions & ChatRequestOptions,
    private readonly modelCatalog: RemoteModelsDevCatalog,
    private readonly resolution?: ResolvedDeployment & { readonly catalogModel?: CatalogModel }
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
    if (options.reasoning !== undefined) {
      if (!(MODEL_REASONING_LEVELS as readonly unknown[]).includes(options.reasoning))
        throw new TypeError(
          `${PREFIX} reasoning must be one of: ${MODEL_REASONING_LEVELS.join(", ")}.`
        )
      this.defaultReasoning = options.reasoning
    }
    this.profile = resolveModel({
      providerId,
      modelId,
      protocol: requestedProtocol,
      options,
      ...this.resolution,
    })
    const protocol = this.profile.protocol
    if (protocol === "messages") validateMessagesOptions(options)
    else if (protocol === "chat") validateChatOptions(options)
    else validateOptions(options)
    if (options.maxOutputTokens !== undefined) this.maxOutputTokens = options.maxOutputTokens
    const { costEstimator, ...serializable } = options
    this.options = {
      ...structuredClone(serializable),
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
    if (this.resolution) return this
    const resolution = await this.deployments.resolve(this.modelId, options?.offline === true)
    const kind = deploymentKind(resolution.deployment)
    if (kind !== "language")
      throw new UnsupportedModelFeatureError(
        `${PREFIX} Use ${KIND_BINDINGS[kind]} for ${kind === "embedding" ? "an" : "a"} ${kind} deployment.`
      )
    let catalogModel: CatalogModel | undefined
    try {
      catalogModel = await this.modelCatalog.get(resolution.deployment.modelName, options?.offline)
    } catch (error) {
      if (!(error instanceof ModelCatalogUnavailableError)) throw error
      // Azure identity was verified above. Only public enrichment may fall back to
      // cached facts or an explicit definition; malformed metadata still fails.
      catalogModel = await this.modelCatalog.get(resolution.deployment.modelName, true)
      if (!catalogModel && !this.options.definition) throw error
    }
    if (await this.modelCatalog.getEmbedding(resolution.deployment.modelName, true))
      throw new UnsupportedModelFeatureError(
        `${PREFIX} Use foundry.embedding() for an embedding deployment.`
      )
    return new FoundryModel(
      this.requestedProtocol,
      this.transport,
      this.deployments,
      this.providerId,
      this.modelId,
      this.options,
      this.modelCatalog,
      {
        ...resolution,
        catalogModel,
      }
    )
  }

  async stream(request: LanguageModelRequest): Promise<LanguageModelStream> {
    request.signal.throwIfAborted()
    if (!this.resolution) {
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
    const response =
      this.protocol === "messages"
        ? await this.postMessages(request)
        : await this.transport.post(
            JSON.stringify(
              this.protocol === "chat"
                ? foundryChatRequest(request, this.definition, this.options, this.scope)
                : responsesRequest(
                    request,
                    this.definition,
                    this.options,
                    this.scope,
                    this.resolution?.deployment
                  )
            ),
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

  /** A limit no count predicts, such as the grammar's compiled size: once more, unconstrained. */
  private async postMessages(request: LanguageModelRequest): Promise<Response> {
    const prepared = foundryMessagesRequest(request, this.definition, this.options, this.scope)
    const post = (body: JsonObject) =>
      this.transport.post(
        JSON.stringify(body),
        request.signal,
        this.providerId,
        this.modelId,
        "messages"
      )
    try {
      return await post(prepared.body)
    } catch (error) {
      if (
        prepared.strictTools === undefined ||
        !(error instanceof ModelProviderError) ||
        !isStrictToolLimitError(error)
      )
        throw error
      strictToolRefusals.add(prepared.strictTools)
      return post(
        foundryMessagesRequest(request, this.definition, this.options, this.scope, true).body
      )
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
