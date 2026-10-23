import type { ImageModel, LanguageModel } from "@sixb/core/models"
import { vercelGateway } from "@sixb/vercel-ai-gateway"

/** The first language model is the default used by the project Agent. */
export const languageModels: readonly [LanguageModel, ...LanguageModel[]] = [
  vercelGateway("deepseek/deepseek-v4-flash-vision-exp"),
  vercelGateway("openai/gpt-5.6-luna"),
  vercelGateway("anthropic/claude-haiku-4.5"),
] as const

/** Images the agent makes through `sixb models image`. The first is the default. */
export const imageModels: readonly [ImageModel, ...ImageModel[]] = [
  vercelGateway.image("bfl/flux-3-image-klein", {
    description: "Fast illustrations and diagrams for reports",
  }),
  vercelGateway.image("google/gemini-3.1-flash-lite-image", {
    description: "Edits or varies a reference image, such as a site photo",
  }),
] as const
