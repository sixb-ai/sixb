import type { LanguageModel } from "@sixb/core/models"
import { vercelGateway } from "@sixb/vercel-ai-gateway"

/** The first language model is the default used by the project Agent. */
export const languageModels: readonly [LanguageModel, ...LanguageModel[]] = [
  vercelGateway("deepseek/deepseek-v4-flash-vision-exp"),
  vercelGateway("openai/gpt-5.6-luna"),
  vercelGateway("anthropic/claude-haiku-4.5"),
] as const
