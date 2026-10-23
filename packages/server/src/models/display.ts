import type { LanguageModelEntry } from "@sixb/core"
import {
  defineLanguageModel,
  defineModelRateCard,
  type LanguageModelDefinition,
  ModelCatalogUnavailableError,
  type ModelRateCard,
  type ModelReasoningLevel,
} from "@sixb/core/models"

/** Presentation only; the configured provider remains the source of model capabilities. */
export async function languageModelDisplay(entry: LanguageModelEntry) {
  const model = await resolvedForDisplay(entry)
  const definition = defineLanguageModel(model.definition)
  if (definition.providerId !== entry.provider || definition.modelId !== entry.modelId) {
    throw new Error("[SixbServer] Model definition identity does not match its catalog entry.")
  }
  const gateway = entry.provider === "vercel-ai-gateway"
  const publisherId = gateway ? entry.modelId.split("/")[0]! : entry.provider
  const via = definition.via ?? (gateway ? "AI Gateway" : undefined)
  const capabilities = definition.capabilities
  const media = capabilities.inputMediaTypes
  const input = ["text"]
  for (const [kind, mime] of [
    ["image", "image/"],
    ["audio", "audio/"],
    ["video", "video/"],
    ["pdf", "application/pdf"],
  ]) {
    if (media === "any" || media?.some((type) => type.startsWith(mime!))) input.push(kind!)
  }
  return {
    name: definition.name ?? entry.modelId,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    publisher: definition.publisher ?? { id: publisherId, name: publisherName(publisherId) },
    ...(via === undefined ? {} : { via }),
    capabilities: {
      input,
      output: ["text"],
      ...(media === undefined ? {} : { attachments: media === "any" || media.length > 0 }),
      ...(capabilities.reasoning === undefined
        ? {}
        : { reasoning: capabilities.reasoning !== false }),
      ...(capabilities.localTools === undefined ? {} : { tools: capabilities.localTools }),
      ...(capabilities.nativeStructuredOutput === undefined
        ? {}
        : { structuredOutput: capabilities.nativeStructuredOutput }),
      ...(definition.contextWindow === undefined
        ? {}
        : { contextWindowTokens: definition.contextWindow }),
    },
    reasoningLevels: reasoningLevels(definition),
    ...rateCardDisplay(entry, model.rateCard),
  }
}

interface DisplayedBinding<TModel> {
  readonly provider: string
  readonly modelId: string
  readonly model: TModel & {
    readonly providerId: string
    readonly modelId: string
    resolve?(): Promise<TModel>
  }
}

/**
 * A binding resolved for its metadata and prices, never for inference. An unavailable provider
 * catalog leaves the configured binding, so the catalog still lists every model.
 */
export async function resolvedForDisplay<
  TModel extends { readonly providerId: string; readonly modelId: string },
>(entry: DisplayedBinding<TModel>): Promise<TModel> {
  try {
    const resolved = await entry.model.resolve?.()
    if (!resolved) return entry.model
    if (resolved.providerId !== entry.provider || resolved.modelId !== entry.modelId) {
      throw new Error("[SixbServer] Resolved model identity does not match its catalog entry.")
    }
    return resolved
  } catch (error) {
    if (!(error instanceof ModelCatalogUnavailableError)) throw error
    console.warn(
      `[SixbServer] Model metadata is unavailable for '${entry.provider}/${entry.modelId}'; using its configured definition.`
    )
    return entry.model
  }
}

// The catalog is read often (the model picker), so each invalid card is reported once.
const reportedInvalidCards = new Set<string>()

/** A binding's prices, shown only when they form a valid card. */
export function rateCardDisplay(
  entry: { readonly provider: string; readonly modelId: string },
  card: ModelRateCard | undefined
): { rateCard?: ModelRateCard } {
  if (!card) return {}
  try {
    return { rateCard: defineModelRateCard(card) }
  } catch {
    const key = JSON.stringify([entry.provider, entry.modelId])
    if (!reportedInvalidCards.has(key)) {
      reportedInvalidCards.add(key)
      console.warn(
        `[SixbServer] The rate card of '${entry.provider}/${entry.modelId}' is invalid; its price is not shown.`
      )
    }
    return {}
  }
}

function reasoningLevels(definition: LanguageModelDefinition): readonly ModelReasoningLevel[] {
  const reasoning = definition.capabilities.reasoning
  if (!reasoning) return []
  return [
    "provider-default",
    ...(reasoning.canDisable ? ["none" as const] : []),
    ...(reasoning.efforts ?? []),
  ]
}

function publisherName(id: string): string {
  const names: Readonly<Record<string, string>> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    deepseek: "DeepSeek",
    google: "Google",
    xai: "xAI",
    spacexai: "xAI",
    zai: "Z.ai",
    meta: "Meta",
    moonshotai: "Moonshot AI",
    nvidia: "NVIDIA",
  }
  return Object.hasOwn(names, id) ? names[id]! : id
}
