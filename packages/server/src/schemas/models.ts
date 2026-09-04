import { MODEL_REASONING_LEVELS } from "@sixb/core/models"
import { z } from "zod"

export const LanguageModelRefSchema = z.object({
  provider: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
})

export const LanguageModelSchema = LanguageModelRefSchema.extend({
  /**
   * The provider binding and model id the project configured. Together they identify the entry;
   * there is no separate Sixb model id.
   */
  isDefault: z.boolean(),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  publisher: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  via: z.string().min(1).optional(),
  capabilities: z.object({
    input: z.array(z.enum(["text", "image", "audio", "video", "pdf"])),
    output: z.array(z.enum(["text", "image", "audio", "video", "pdf"])),
    attachments: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    tools: z.boolean().optional(),
    structuredOutput: z.boolean().optional(),
    contextWindowTokens: z.number().int().positive().optional(),
  }),
  reasoningLevels: z.array(z.enum(MODEL_REASONING_LEVELS)),
})

export const ModelCatalogSchema = z.object({
  language: z.array(LanguageModelSchema),
})

export const ModelReasoningLevelSchema = z.enum(MODEL_REASONING_LEVELS)

export const ModelReasoningSchema = z.union([
  ModelReasoningLevelSchema,
  z.object({ budgetTokens: z.number().int().nonnegative() }).strict(),
])
