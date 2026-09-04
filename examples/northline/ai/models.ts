import type { ModelCatalogInput } from "@sixb/core"
import { vercelGateway } from "@sixb/vercel-ai-gateway"

type LanguageModel = ModelCatalogInput["language"][number]

/** The first language model is the default used by the project Agent. */
export const languageModels: readonly [LanguageModel, ...LanguageModel[]] = [
  vercelGateway("deepseek/deepseek-v4-flash-vision-exp"),
  vercelGateway("openai/gpt-5.6-luna"),
  vercelGateway("anthropic/claude-haiku-4.5"),
] as const
