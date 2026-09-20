import {
  defineLanguageModel,
  defineModelRateCard,
  type LanguageModelDefinition,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import type { CatalogModel } from "./catalog"
import type { ChatRequestOptions } from "./chat-request"
import type { AzureAIFoundryDeployment } from "./discovery"
import type { MessagesRequestOptions } from "./messages-request"
import type { AzureAIFoundryModelMetadata, AzureAIFoundryModelOptions } from "./provider"
import { azurePublisher } from "./publisher"
import type { FoundryProtocol } from "./transport"
import { PREFIX } from "./util"

// One composition path for catalog listing, worker resolution, and direct execution.
export function resolveModel(input: {
  providerId: string
  modelId: string
  protocol?: FoundryProtocol
  options: AzureAIFoundryModelOptions & ChatRequestOptions & MessagesRequestOptions
  deployment?: AzureAIFoundryDeployment
  discoveredAt?: string
  catalogModel?: CatalogModel
}) {
  const { deployment, options } = input
  const metadata: AzureAIFoundryModelMetadata = deployment
    ? {
        publisher: deployment.modelPublisher,
        modelName: deployment.modelName,
        modelVersion: deployment.modelVersion,
        sku: deployment.sku.name,
        deployment,
        discoveredAt: input.discoveredAt,
      }
    : {}
  const entry = input.catalogModel
  const deploymentPublisher = deployment && azurePublisher(deployment.modelPublisher)
  const publisher =
    deploymentPublisher?.id === "fireworks-ai"
      ? (entry?.definition.publisher ?? deploymentPublisher)
      : (deploymentPublisher ?? entry?.definition.publisher)
  const protocol =
    input.protocol ??
    entry?.protocol ??
    (deployment?.capabilities.responses === "true"
      ? "responses"
      : deployment?.capabilities.chatCompletion === "true" ||
          deployment?.capabilities.chat_completion === "true"
        ? "chat"
        : deployment?.capabilities.messages === "true"
          ? "messages"
          : "responses")
  if (protocol === "messages" && deployment?.connectionName)
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Native Messages cannot route a deployment from a project connection; use the owning resource's project URL and API key.`
    )
  const flag =
    deployment?.capabilities[protocol === "chat" ? "chatCompletion" : protocol] ??
    (protocol === "chat" ? deployment?.capabilities.chat_completion : undefined)
  if (flag === "false")
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Deployment '${input.modelId}' reports that ${protocol === "chat" ? "Chat" : protocol === "responses" ? "Responses" : "Messages"} is unsupported.`
    )
  const definition = defineLanguageModel({
    ...entry?.definition,
    publisher,
    via: "Azure AI Foundry",
    ...options.definition,
    kind: "language",
    providerId: input.providerId,
    modelId: input.modelId,
    capabilities: {
      ...entry?.definition.capabilities,
      ...options.definition?.capabilities,
    },
  })
  return {
    protocol,
    // Until Azure verifies the deployment, limits are not executable metadata.
    // In particular, Sixb treats advertised context limits as ready for offline resolution.
    definition: deployment
      ? effectiveDefinition(definition, protocol, options)
      : defineLanguageModel({
          kind: "language",
          providerId: input.providerId,
          modelId: input.modelId,
          publisher: definition.publisher,
          via: definition.via,
          capabilities: {},
        }),
    metadata: Object.freeze({
      ...metadata,
      ...(entry
        ? {
            catalog: Object.freeze({
              provider: entry.catalogProvider,
              modelId: entry.modelName,
              source: "https://models.dev/api.json",
              pricing: "reference" as const,
            }),
          }
        : {}),
    }),
    rateCard: options.rateCard ? defineModelRateCard(options.rateCard) : entry?.rateCard,
    aliases: Object.freeze([
      ...new Set([
        input.modelId,
        ...(entry ? [entry.modelName] : []),
        ...(metadata.modelName
          ? [
              metadata.modelName,
              ...(metadata.modelVersion && protocol !== "messages"
                ? [`${metadata.modelName}-${metadata.modelVersion}`]
                : []),
            ]
          : []),
      ]),
    ]),
  }
}

// Catalog facts and explicit overrides still have to fit the selected wire adapter.
function effectiveDefinition(
  definition: LanguageModelDefinition,
  protocol: FoundryProtocol,
  options: AzureAIFoundryModelOptions & ChatRequestOptions & MessagesRequestOptions
): LanguageModelDefinition {
  const caps = definition.capabilities
  const media = caps.inputMediaTypes
  const supported = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    ...(protocol === "chat" ? [] : ["application/pdf"]),
  ]
  let reasoning = caps.reasoning
  if (reasoning) {
    const { budgetTokens, efforts, ...rest } = reasoning
    const max =
      Math.min(definition.maxOutputTokens ?? Infinity, options.maxOutputTokens ?? Infinity) - 1
    const min = Math.max(1024, budgetTokens?.min ?? 0)
    const budgetMax = Math.min(max, budgetTokens?.max ?? Infinity)
    reasoning = {
      ...rest,
      ...(efforts && !(protocol === "messages" && options.thinkingMode === "manual")
        ? { efforts: efforts.filter((effort) => protocol !== "messages" || effort !== "minimal") }
        : {}),
      ...(budgetTokens &&
      protocol === "messages" &&
      options.thinkingMode !== "adaptive" &&
      budgetMax >= min
        ? { budgetTokens: { min, ...(Number.isFinite(budgetMax) ? { max: budgetMax } : {}) } }
        : {}),
    }
  }
  return defineLanguageModel({
    ...definition,
    capabilities: {
      ...caps,
      ...(media === undefined
        ? {}
        : {
            inputMediaTypes: supported.filter(
              (type) =>
                media === "any" ||
                media.includes(type) ||
                (type.startsWith("image/") && media.includes("image/*"))
            ),
          }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(protocol === "chat" && options.profile === "deepseek"
        ? { nativeStructuredOutput: false }
        : {}),
      ...(caps.providerExecutedTools ? { providerExecutedTools: false } : {}),
    },
  })
}
