import type { DecisionModel, ImageModel, LanguageModelTiers } from "@sixb/core/models"
import { vercelGateway } from "@sixb/vercel-ai-gateway"

/**
 * Open-weight models by tier. `standard` is the default; with the decision model below, chat picks
 * the tier of each message: lookups go light, investigations and plans go heavy.
 */
export const languageModels: LanguageModelTiers = {
  light: vercelGateway("zai/glm-5.3-flash", { reasoning: "low" }),
  standard: vercelGateway("deepseek/deepseek-v4.1-flash", { reasoning: "high" }),
  heavy: vercelGateway("moonshotai/kimi-k3", { reasoning: "high" }),
}

/** Scores each chat message's tier in about 150 ms, before the answer starts. */
export const decisionModels: readonly DecisionModel[] = [vercelGateway.decision("typesafe-ai/jev")]

/** Images the agent makes through `sixb models image`. The first is the default. */
export const imageModels: readonly [ImageModel, ...ImageModel[]] = [
  vercelGateway.image("bfl/flux-3-image-klein", {
    description: "Fast illustrations and diagrams for reports",
  }),
  vercelGateway.image("google/gemini-3.1-flash-lite-image", {
    description: "Edits or varies a reference image, such as a site photo",
  }),
] as const
