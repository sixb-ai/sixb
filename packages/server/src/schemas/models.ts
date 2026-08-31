import { z } from "zod"

export const LanguageModelSchema = z.object({
  /**
   * The AI SDK binding and model id the project configured. Together they identify the entry;
   * there is no separate Sixb model id.
   */
  provider: z.string(),
  modelId: z.string(),
  isDefault: z.boolean(),
})

export const ModelCatalogSchema = z.object({
  language: z.array(LanguageModelSchema),
})
