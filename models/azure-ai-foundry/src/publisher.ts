import type { LanguageModelDefinition } from "@sixb/core/models"

type Publisher = NonNullable<LanguageModelDefinition["publisher"]>

const publishers: Readonly<Record<string, Publisher>> = {
  openai: { id: "openai", name: "OpenAI" },
  anthropic: { id: "anthropic", name: "Anthropic" },
  deepseek: { id: "deepseek", name: "DeepSeek" },
  meta: { id: "meta", name: "Meta" },
  microsoft: { id: "microsoft", name: "Microsoft" },
  mistralai: { id: "mistral", name: "Mistral AI" },
  moonshotai: { id: "moonshotai", name: "Moonshot AI" },
  zai: { id: "zai", name: "Z.ai" },
  xai: { id: "spacexai", name: "xAI" },
  fireworks: { id: "fireworks-ai", name: "Fireworks" },
  fireworksai: { id: "fireworks-ai", name: "Fireworks" },
}

export function azurePublisher(name: string): Publisher {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "")
  return Object.hasOwn(publishers, key)
    ? publishers[key]!
    : { id: name.toLowerCase().replace(/\s+/g, "-"), name }
}

/** Presentation mapping of catalog families, never deployment names or model capabilities. */
export function fireworksPublisher(family: unknown): Publisher | undefined {
  if (typeof family !== "string") return undefined
  const group = family.split("-")[0]
  if (group === "glm") return publishers.zai
  if (group === "kimi") return publishers.moonshotai
  if (group === "deepseek") return publishers.deepseek
  return undefined
}
