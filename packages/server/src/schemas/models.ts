import { z } from "zod"

export const LanguageModelSchema = z.object({
  /**
   * The AI SDK binding and model id the project configured. Together they identify the entry;
   * the runtime's internal reference is not part of this contract.
   */
  provider: z.string(),
  modelId: z.string(),
  isDefault: z.boolean(),
})

export const ModelCatalogSchema = z.object({
  language: z.array(LanguageModelSchema),
})
