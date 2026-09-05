import catalogJson from "./catalog.json"

interface ModelsDevCatalogModel {
  readonly limits?: {
    readonly context: number
    readonly input?: number
  }
}

export interface ModelsDevContextLimits {
  readonly contextTokens: number
  readonly inputTokens?: number
}

const providers: Readonly<Record<string, Readonly<Record<string, ModelsDevCatalogModel>>>> =
  catalogJson.providers

/** The owned Gateway provider uses the Models.dev `vercel` catalog namespace. */
const PROVIDER_BINDINGS: Readonly<Record<string, string>> = {
  "vercel-ai-gateway": "vercel",
}

/** Resolve exact context limits from the pinned snapshot; pricing is owned by model providers. */
export function resolveModelsDevContextLimits(model: {
  readonly providerId: string
  readonly modelId: string
}): ModelsDevContextLimits | undefined {
  const providerId = PROVIDER_BINDINGS[model.providerId] ?? model.providerId
  const limits = providers[providerId]?.[model.modelId]?.limits
  if (!limits) return undefined
  return {
    contextTokens: limits.context,
    ...(limits.input === undefined ? {} : { inputTokens: limits.input }),
  }
}
