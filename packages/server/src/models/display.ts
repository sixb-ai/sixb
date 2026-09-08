import type { LanguageModelEntry } from "@sixb/core"
import {
  defineLanguageModel,
  type LanguageModelDefinition,
  ModelCatalogUnavailableError,
  type ModelReasoningLevel,
} from "@sixb/core/models"

/** Presentation only; the configured provider remains the source of model capabilities. */
export async function languageModelDisplay(entry: LanguageModelEntry) {
  let definition = entry.model.definition
  try {
    const resolved = await entry.model.resolve?.()
    if (resolved) {
      if (resolved.providerId !== entry.provider || resolved.modelId !== entry.modelId) {
        throw new Error("[SixbServer] Resolved model identity does not match its catalog entry.")
      }
      definition = resolved.definition
    }
  } catch (error) {
    if (!(error instanceof ModelCatalogUnavailableError)) throw error
    console.warn(
      `[SixbServer] Model metadata is unavailable for '${entry.provider}/${entry.modelId}'; using its configured definition.`
    )
  }
  definition = defineLanguageModel(definition)
  if (definition.providerId !== entry.provider || definition.modelId !== entry.modelId) {
    throw new Error("[SixbServer] Model definition identity does not match its catalog entry.")
  }
  const gateway = entry.provider === "vercel-ai-gateway"
  const publisherId = gateway ? entry.modelId.split("/")[0]! : entry.provider
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
    publisher: { id: publisherId, name: publisherName(publisherId) },
    ...(gateway ? { via: "AI Gateway" } : {}),
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
