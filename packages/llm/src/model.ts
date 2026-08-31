import type { LanguageModelStreamEvent } from "./events"
import type { JsonObject } from "./json"
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
  readonly capabilities?: ModelCapabilities | (() => Promise<ModelCapabilities>)
  stream(request: LanguageModelRequest): Promise<LanguageModelStream>
}

export async function resolveModelCapabilities(model: LanguageModel): Promise<ModelCapabilities> {
  return typeof model.capabilities === "function"
    ? model.capabilities()
    : (model.capabilities ?? {})
}
