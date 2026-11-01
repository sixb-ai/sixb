import type { JsonObject, ReadonlyJsonObject } from "../json"
import type { LanguageModelDefinitionCatalog, ModelDefinitionCatalog } from "./catalog"
import type { LanguageModelDefinition } from "./definitions"
import type { LanguageModelStreamEvent } from "./events"
import type { ModelMessage } from "./messages"
import type { ModelCostEstimator } from "./pricing"
import type { ModelRateCard } from "./rate-card"

export const MODEL_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const

export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number]

export const MODEL_REASONING_LEVELS = [
  "provider-default",
  "none",
  ...MODEL_REASONING_EFFORTS,
] as const

export type ModelReasoningLevel = (typeof MODEL_REASONING_LEVELS)[number]

/** Exact provider-native reasoning budget, expressed in tokens. */
export interface ModelReasoningBudget extends ReadonlyJsonObject {
  readonly budgetTokens: number
}

/** Provider-neutral reasoning preference accepted by every language-model runtime. */
export type ModelReasoning = ModelReasoningLevel | ModelReasoningBudget

export interface ModelReasoningBudgetCapabilities {
  readonly min?: number
  readonly max?: number
}

/** Controls exposed by one concrete model offering through one provider. */
export interface ModelReasoningCapabilities {
  readonly canDisable?: boolean
  readonly efforts?: readonly ModelReasoningEffort[]
  readonly budgetTokens?: ModelReasoningBudgetCapabilities
}

export interface ModelCapabilities {
  readonly inputMediaTypes?: readonly string[] | "any"
  /** `undefined` is unknown, `false` is unsupported, and an object describes supported controls. */
  readonly reasoning?: false | ModelReasoningCapabilities
  readonly localTools?: boolean
  readonly parallelToolCalls?: boolean
  /** `undefined` is unknown, not an assertion that schema-constrained output is unsupported. */
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
  readonly reasoning?: ModelReasoning
  /** Per-call output ceiling; providers must not exceed a stricter configured model limit. */
  readonly maxOutputTokens?: number
  /**
   * How the provider caches the request's prompt, never over explicit provider configuration.
   * Absent, it caches what it expects to be read again.
   */
  readonly caching?: ModelCaching
  readonly responseFormat?: ModelResponseFormat
  readonly signal: AbortSignal
}

/**
 * `"off"` caches nothing and `"auto"` caches the request even when it is read once. An intent
 * caches what an absent choice would, and says how the prompt is read again: each provider
 * translates it, or ignores what it has no equivalent for.
 */
export type ModelCaching = "auto" | "off" | ModelCachingIntent

export interface ModelCachingIntent {
  /**
   * `"long"`: the prompt is read again after a human pause, as by a conversation's next turn, so
   * its cache should outlive the provider's default lifetime. `"default"` keeps that lifetime.
   */
  readonly lifetime?: "default" | "long"
  /**
   * An opaque id the requests that share a prompt prefix share, such as one conversation's, for a
   * provider that routes them to where that prefix is cached. Never personal data.
   */
  readonly key?: string
}

export interface LanguageModelStream {
  readonly events: AsyncIterable<LanguageModelStreamEvent>
}

export interface LanguageModel {
  readonly providerId: string
  readonly modelId: string
  readonly definition: LanguageModelDefinition
  readonly costEstimator?: ModelCostEstimator
  /**
   * The prices this binding bills by, for people and agents choosing a model. Pricing itself
   * goes through costEstimator; absent when the price is unknown.
   */
  readonly rateCard?: ModelRateCard
  /**
   * Reasoning Sixb applies whenever this model runs without an explicit choice: chat turns, AI
   * workflow steps, subagents, and direct generation. Providers set it from their model options;
   * Sixb checks it against `definition.capabilities` at startup.
   */
  readonly defaultReasoning?: ModelReasoningLevel
  /**
   * Output limit the binding sets for every call, agent calls included. Unlike
   * `definition.maxOutputTokens`, the most the model itself can produce, this is the developer's
   * choice. Providers set it from their model options; Sixb checks it against that maximum at
   * startup.
   */
  readonly maxOutputTokens?: number
  /**
   * Return an executable model pinned to operational metadata, preserving model identity.
   * `offline` requires a local snapshot without catalog I/O. Workers retain this model
   * for generation and compaction; later catalog refreshes must not change its capabilities/limits.
   * Throw ModelCatalogUnavailableError for catalog transport/access failures to allow workers to
   * retry with an offline snapshot. Invalid definitions and other resolver errors remain fatal.
   */
  resolve?(options?: { readonly offline?: boolean }): Promise<LanguageModel>
  /** Validate known output constraints without inference. Success does not certify endpoint support. */
  validateResponseFormat?(format: ModelResponseFormat): void | Promise<void>
  stream(request: LanguageModelRequest): Promise<LanguageModelStream>
}

/** The common callable provider shape. Provider packages may accept additional model options. */
export interface ModelProvider<TCatalog extends ModelDefinitionCatalog = ModelDefinitionCatalog> {
  readonly providerId: string
  readonly catalog: TCatalog
}

export interface LanguageModelProvider extends ModelProvider<LanguageModelDefinitionCatalog> {
  (modelId: string): LanguageModel
}

export function isModelReasoning(value: unknown): value is ModelReasoning {
  if (typeof value === "string") {
    return (MODEL_REASONING_LEVELS as readonly string[]).includes(value)
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  if (Object.keys(value).length !== 1) return false
  const budgetTokens = (value as { readonly budgetTokens?: unknown }).budgetTokens
  return typeof budgetTokens === "number" && Number.isSafeInteger(budgetTokens) && budgetTokens >= 0
}

/** Explain why a request cannot be represented by known model capabilities. Unknown is allowed. */
export function modelReasoningSupportIssue(
  capabilities: ModelCapabilities["reasoning"],
  reasoning: unknown
): string | undefined {
  if (reasoning === undefined) return undefined
  if (!isModelReasoning(reasoning)) return "the reasoning preference is invalid"
  if (reasoning === "provider-default") return undefined
  if (capabilities === undefined) return undefined
  if (capabilities === false) return "reasoning is not supported"
  if (reasoning === "none") {
    return capabilities.canDisable === true ? undefined : "reasoning cannot be disabled"
  }
  if (typeof reasoning === "string") {
    return capabilities.efforts?.includes(reasoning) === true
      ? undefined
      : `reasoning effort '${reasoning}' is not supported`
  }
  const budget = capabilities.budgetTokens
  if (budget === undefined) return "reasoning token budgets are not supported"
  if (budget.min !== undefined && reasoning.budgetTokens < budget.min) {
    return `reasoning token budget must be at least ${budget.min}`
  }
  if (budget.max !== undefined && reasoning.budgetTokens > budget.max) {
    return `reasoning token budget must not exceed ${budget.max}`
  }
  return undefined
}
