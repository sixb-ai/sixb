import type { JsonObject } from "../json"
import type { LanguageModelCatalog, ModelCatalog } from "./catalog"
import type { LanguageModelDefinition } from "./definitions"
import type { LanguageModelStreamEvent } from "./events"
import type { ModelMessage } from "./messages"

export type ModelReasoningLevel =
  | "provider-default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"

export interface ModelCapabilities {
  readonly inputMediaTypes?: readonly string[] | "any"
  readonly reasoning?: boolean
  readonly localTools?: boolean
  readonly parallelToolCalls?: boolean
  readonly nativeStructuredOutput?: boolean
  readonly providerExecutedTools?: boolean
}

export interface ModelToolSpecification {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
}

export interface ModelResponseFormat {
  readonly type: "json"
  readonly name: string
  readonly description?: string
  readonly schema: JsonObject
}

export interface LanguageModelRequest {
  readonly callId: string
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolSpecification[]
  readonly reasoning?: ModelReasoningLevel
  readonly responseFormat?: ModelResponseFormat
  readonly signal: AbortSignal
}

export interface LanguageModelStream {
  readonly events: AsyncIterable<LanguageModelStreamEvent>
}

export interface LanguageModel {
  readonly providerId: string
  readonly modelId: string
  readonly definition: LanguageModelDefinition | (() => Promise<LanguageModelDefinition>)
  stream(request: LanguageModelRequest): Promise<LanguageModelStream>
}

/** The common callable provider shape. Provider packages may accept additional model options. */
export interface ModelProvider<TCatalog extends ModelCatalog = ModelCatalog> {
  readonly providerId: string
  readonly catalog: TCatalog
}

export interface LanguageModelProvider extends ModelProvider<LanguageModelCatalog> {
  (modelId: string): LanguageModel
}

export async function resolveModelCapabilities(model: LanguageModel): Promise<ModelCapabilities> {
  return (await resolveLanguageModelDefinition(model)).capabilities
}

export async function resolveLanguageModelDefinition(
  model: LanguageModel
): Promise<LanguageModelDefinition> {
  const definition =
    typeof model.definition === "function" ? await model.definition() : model.definition
  if (definition.providerId !== model.providerId || definition.modelId !== model.modelId) {
    throw new TypeError(
      `[Sixb] Resolved definition for '${model.providerId}/${model.modelId}' has a different identity.`
    )
  }
  return definition
}
