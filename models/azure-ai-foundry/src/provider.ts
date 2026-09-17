import {
  assertJsonObject,
  defineLanguageModel,
  type JsonObject,
  type LanguageModel,
  type LanguageModelDefinition,
  type LanguageModelProvider,
  type LanguageModelRateCard,
  type LanguageModelRequest,
  type LanguageModelStreamEvent,
  type ModelCostEstimator,
  ModelProviderError,
} from "@sixb/core/models"
import { chatEvents } from "@sixb/model-protocols/chat"
import { messagesEvents } from "@sixb/model-protocols/messages"
import { responsesEvents } from "@sixb/model-protocols/responses"
import { foundryEstimator, foundryUsage } from "./accounting"
import { foundryChatEstimator, foundryChatUsage } from "./chat-accounting"
import { type ChatRequestOptions, foundryChatRequest, validateChatOptions } from "./chat-request"
import {
  type AzureAIFoundryCatalog,
  type AzureAIFoundryDeployment,
  type AzureAIFoundryDiscoveryOptions,
  FoundryCatalog,
  type ResolvedDeployment,
} from "./discovery"
import { foundryMessagesEstimator, foundryMessagesUsage } from "./messages-accounting"
import {
  foundryMessagesRequest,
  type MessagesRequestOptions,
  validateClaudeOffering,
  validateMessagesOptions,
} from "./messages-request"
import { type RequestOptions, responsesRequest, validateOptions } from "./request"
import {
  type FoundryProtocol,
  FoundryTransport,
  requestId,
  type TransportOptions,
} from "./transport"
import { object, PREFIX } from "./util"

export interface AzureAIFoundryOptions extends TransportOptions {
  /** Namespace bindings from different resources/projects in a single Sixb catalog. */
  readonly providerId?: string
  readonly models?: readonly LanguageModelDefinition[]
  /** Opt in to bounded project-deployment discovery. */
  readonly discovery?: AzureAIFoundryDiscoveryOptions
}

export interface AzureAIFoundryModelMetadata {
  readonly publisher?: string
  readonly modelName?: string
  readonly modelVersion?: string
  /** Foundry Claude hosting; version 1 is Anthropic infrastructure, version 2 is Azure. */
  readonly hosting?: "azure" | "anthropic"
  readonly deployment?: AzureAIFoundryDeployment
  readonly discoveredAt?: string
}

export interface AzureAIFoundryModelOptions extends RequestOptions {
  readonly definition?: Omit<LanguageModelDefinition, "kind" | "providerId" | "modelId">
  readonly metadata?: Pick<
    AzureAIFoundryModelMetadata,
    "publisher" | "modelName" | "modelVersion" | "hosting"
  >
  readonly rateCard?: LanguageModelRateCard
  readonly costEstimator?: ModelCostEstimator
  /** Non-OpenAI Foundry counters can report zero despite reasoning. Default: unknown unless publisher is OpenAI. */
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

export interface AzureAIFoundryModel<Protocol extends FoundryProtocol = "responses">
  extends LanguageModel {
  readonly protocol: Protocol
  readonly metadata: AzureAIFoundryModelMetadata
  resolve(options?: { readonly offline?: boolean }): Promise<AzureAIFoundryModel<Protocol>>
}

export interface AzureAIFoundryProvider extends LanguageModelProvider {
  (deploymentName: string, options?: AzureAIFoundryModelOptions): AzureAIFoundryModel
  responses(deploymentName: string, options?: AzureAIFoundryModelOptions): AzureAIFoundryModel
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
  const catalog = new FoundryCatalog(
    providerId,
    definitions,
    transport.baseUrl,
    options,
    options.discovery
  )
  const model = <P extends FoundryProtocol>(
    protocol: P,
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
      catalog,
      providerId,
      deploymentName,
      modelOptions,
      {
        definition: catalog.localDefinition(deploymentName),
      }
    )
  }
  const responses = (name: string, options: AzureAIFoundryModelOptions = {}) =>
    model("responses", name, options)
  const messages = (name: string, options: AzureAIFoundryMessagesOptions = {}) =>
    model("messages", name, options)
  const chat = (name: string, options: AzureAIFoundryChatOptions = {}) =>
    model("chat", name, options)
  return Object.assign(responses, { providerId, catalog, responses, messages, chat })
}

class FoundryModel<Protocol extends FoundryProtocol> implements AzureAIFoundryModel<Protocol> {
  readonly definition: LanguageModelDefinition
  readonly metadata: AzureAIFoundryModelMetadata
  readonly costEstimator: ModelCostEstimator
  private readonly options: AzureAIFoundryModelOptions & MessagesRequestOptions & ChatRequestOptions
  private readonly scope: string
  private readonly reliableReasoning: boolean

  constructor(
    readonly protocol: Protocol,
    private readonly transport: FoundryTransport,
    private readonly catalog: FoundryCatalog,
    readonly providerId: string,
    readonly modelId: string,
    options: AzureAIFoundryModelOptions & MessagesRequestOptions & ChatRequestOptions,
    resolution: ResolvedDeployment,
    private readonly resolved = false
  ) {
    if (options.request !== undefined)
      assertJsonObject(options.request, `${PREFIX} request options`)
    transport.url(protocol)
    if (protocol === "messages") validateMessagesOptions(options)
    else if (protocol === "chat") validateChatOptions(options)
    else validateOptions(options)
    if (options.rateCard && options.costEstimator)
      throw new TypeError(`${PREFIX} Configure either rateCard or costEstimator, not both.`)
    if (
      options.reasoningUsage !== undefined &&
      !["reported", "unknown"].includes(options.reasoningUsage)
    )
      throw new TypeError(`${PREFIX} Invalid reasoningUsage.`)
    this.definition = defineLanguageModel({
      ...resolution.definition,
      ...options.definition,
      capabilities: { ...resolution.definition?.capabilities, ...options.definition?.capabilities },
      kind: "language",
      providerId,
      modelId,
    })
    const explicitMetadata = {
      ...(options.metadata?.publisher === undefined
        ? {}
        : { publisher: options.metadata.publisher }),
      ...(options.metadata?.modelName === undefined
        ? {}
        : { modelName: options.metadata.modelName }),
      ...(options.metadata?.modelVersion === undefined
        ? {}
        : { modelVersion: options.metadata.modelVersion }),
      ...(options.metadata?.hosting === undefined ? {} : { hosting: options.metadata.hosting }),
    }
    for (const value of Object.values(explicitMetadata)) {
      if (typeof value !== "string" || !value.trim())
        throw new TypeError(`${PREFIX} Metadata values must be nonempty strings.`)
    }
    const deployment = resolution.deployment
    this.metadata = Object.freeze({
      ...(deployment
        ? {
            publisher: deployment.modelPublisher,
            modelName: deployment.modelName,
            ...(deployment.modelVersion ? { modelVersion: deployment.modelVersion } : {}),
            deployment,
            discoveredAt: resolution.discoveredAt,
          }
        : {}),
      ...explicitMetadata,
    })
    if (
      this.metadata.hosting !== undefined &&
      !["azure", "anthropic"].includes(this.metadata.hosting)
    )
      throw new TypeError(`${PREFIX} Invalid hosting; use azure or anthropic.`)
    if (protocol === "messages") validateClaudeOffering(this.metadata, transport.entra)
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
      options.reasoningUsage === "reported" ||
      (options.reasoningUsage === undefined && this.metadata.publisher?.toLowerCase() === "openai")
    this.costEstimator =
      options.costEstimator ??
      (protocol === "messages"
        ? foundryMessagesEstimator
        : protocol === "chat"
          ? foundryChatEstimator
          : foundryEstimator)(
        options.rateCard,
        this.options.request,
        this.metadata.modelName,
        this.metadata.modelVersion
      )
    Object.freeze(this)
  }

  async resolve(options?: { readonly offline?: boolean }): Promise<AzureAIFoundryModel<Protocol>> {
    if (this.resolved || !this.catalog.enabled) return this
    const resolution = await this.catalog.resolveDefinition(
      this.modelId,
      options?.offline === true,
      this.protocol
    )
    return new FoundryModel(
      this.protocol,
      this.transport,
      this.catalog,
      this.providerId,
      this.modelId,
      this.options,
      resolution,
      true
    )
  }

  async stream(request: LanguageModelRequest) {
    request.signal.throwIfAborted()
    const body =
      this.protocol === "messages"
        ? foundryMessagesRequest(request, this.definition, this.options, this.metadata, this.scope)
        : this.protocol === "chat"
          ? foundryChatRequest(request, this.definition, this.options, this.metadata, this.scope)
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
    const id = requestId(response)
    if (!response.body)
      throw new ModelProviderError(
        `${PREFIX} Provider returned an empty streaming response.`,
        this.providerId,
        this.modelId,
        { requestId: id, status: response.status }
      )
    return {
      events: this.events(
        this.protocol === "messages"
          ? messagesEvents(response.body, request.signal, {
              providerId: this.providerId,
              modelId: this.modelId,
              requestId: id,
              errorPrefix: PREFIX,
              usage: foundryMessagesUsage,
            })
          : this.protocol === "chat"
            ? chatEvents(response.body, request.signal, {
                providerId: this.providerId,
                modelId: this.modelId,
                requestId: id,
                errorPrefix: PREFIX,
                usage: (raw) => foundryChatUsage(raw, this.reliableReasoning),
              })
            : responsesEvents(response.body, request.signal, {
                providerId: this.providerId,
                modelId: this.modelId,
                requestId: id,
                errorPrefix: PREFIX,
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
              })
      ),
    }
  }

  private async *events(
    source: AsyncIterable<LanguageModelStreamEvent>
  ): AsyncIterable<LanguageModelStreamEvent> {
    for await (const event of source) {
      if (event.type === "provider-state" && event.providerId === this.providerId) {
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
  }
}
