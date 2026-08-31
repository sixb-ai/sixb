import catalogJson from "./catalog.json"

export interface ModelsDevCatalogRateSet {
  readonly input: string
  readonly output: string
  readonly cacheRead?: string
  readonly cacheWrite?: string
  readonly reasoning?: string
  readonly inputAudio?: string
  readonly outputAudio?: string
}

export interface ModelsDevCatalogTier extends ModelsDevCatalogRateSet {
  readonly aboveInputTokens: string
}

export interface ModelsDevCatalogPricing extends ModelsDevCatalogRateSet {
  readonly tiers?: readonly ModelsDevCatalogTier[]
  readonly modes?: Readonly<Record<string, Omit<ModelsDevCatalogPricing, "modes">>>
}

interface ModelsDevCatalogLimits {
  readonly context: number
  readonly input?: number
}

export interface ModelsDevCatalogModel {
  readonly limits?: ModelsDevCatalogLimits
  readonly pricing?: ModelsDevCatalogPricing
}

interface ModelsDevCatalog {
  readonly source: {
    readonly id: string
    readonly version: string
    readonly url: string
    readonly observedAt: string
  }
  readonly providers: Readonly<Record<string, Readonly<Record<string, ModelsDevCatalogModel>>>>
}

export interface ModelsDevContextLimits {
  readonly contextTokens: number
  readonly inputTokens?: number
}

/** Reviewed AI SDK namespaces whose provider key differs from Models.dev. */
const SDK_PROVIDER_BINDINGS: Readonly<Record<string, string>> = {
  "anthropic.messages": "anthropic",
  "openai.responses": "openai",
  "openai.chat": "openai",
  "google.generative-ai": "google",
  "amazon-bedrock.converse": "amazon-bedrock",
  gateway: "vercel",
  "gateway.language-model": "vercel",
  bedrock: "amazon-bedrock",
  "google.vertex": "google-vertex",
  "google.vertex.anthropic": "google-vertex",
  vertex: "google-vertex",
  "groq.chat": "groq",
  "wafer.ai.chat": "wafer.ai",
}

const catalog = catalogJson as ModelsDevCatalog

/** Metadata for the immutable Models.dev snapshot shipped with this agent worker. */
export const MODELS_DEV_CATALOG_SOURCE = Object.freeze({
  sourceId: catalog.source.id,
  sourceVersion: catalog.source.version,
  sourceUrl: catalog.source.url,
  observedAt: new Date(catalog.source.observedAt),
})

/** Resolve only exact catalog providers or reviewed AI SDK namespace bindings. */
export function resolveModelsDevProviderId(sdkProviderId: string): string | undefined {
  return (
    SDK_PROVIDER_BINDINGS[sdkProviderId] ??
    (Object.hasOwn(catalog.providers, sdkProviderId) ? sdkProviderId : undefined)
  )
}

export function getModelsDevProviderModels(
  providerId: string
): Readonly<Record<string, ModelsDevCatalogModel>> | undefined {
  return catalog.providers[providerId]
}

export function getModelsDevCatalogModel(
  providerId: string,
  modelId: string
): ModelsDevCatalogModel | undefined {
  return catalog.providers[providerId]?.[modelId]
}

/** Resolve a model's exact context limits from the pinned catalog. */
export function resolveModelsDevContextLimits(model: {
  readonly provider: string
  readonly modelId: string
}): ModelsDevContextLimits | undefined {
  const providerId = resolveModelsDevProviderId(model.provider)
  if (providerId === undefined) return undefined

  const limits = getModelsDevCatalogModel(providerId, model.modelId)?.limits
  if (!limits) return undefined

  return {
    contextTokens: limits.context,
    ...(limits.input === undefined ? {} : { inputTokens: limits.input }),
  }
}
