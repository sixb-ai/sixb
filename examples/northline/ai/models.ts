import type { ModelCatalogInput } from "@sixb/core"
import { gateway } from "ai"

type LanguageModel = ModelCatalogInput["language"][number]

/** The first language model is the default used by the project Agent. */
export const languageModels: readonly [LanguageModel, ...LanguageModel[]] = [
  gateway("deepseek/deepseek-v4-flash-vision-exp"),
  gateway("openai/gpt-5.6-luna"),
  gateway("anthropic/claude-haiku-4.5"),
] as const
