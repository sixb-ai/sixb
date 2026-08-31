import { MODEL_REASONING_LEVELS } from "@sixb/core/models"
import { z } from "zod"

export const LanguageModelSchema = z.object({
  /** The provider and model id configured by the project identify this catalog entry. */
  provider: z.string(),
  modelId: z.string(),
  isDefault: z.boolean(),
})

export const ModelCatalogSchema = z.object({
  language: z.array(LanguageModelSchema),
})

export const ModelReasoningLevelSchema = z.enum(MODEL_REASONING_LEVELS)

export const ModelReasoningSchema = z.union([
  ModelReasoningLevelSchema,
  z.object({ budgetTokens: z.number().int().nonnegative() }).strict(),
])
