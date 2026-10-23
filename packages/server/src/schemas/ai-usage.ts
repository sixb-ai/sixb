import { z } from "zod"

const TokenCountSchema = z.number().int().nonnegative()

/** Provider-neutral run usage aggregated from the durable model-call ledger. */
export const AiUsageSummarySchema = z.object({
  inputTokens: TokenCountSchema.optional(),
  outputTokens: TokenCountSchema.optional(),
  totalTokens: TokenCountSchema.optional(),
  uncachedInputTokens: TokenCountSchema.optional(),
  cacheReadInputTokens: TokenCountSchema.optional(),
  cacheWriteInputTokens: TokenCountSchema.optional(),
  textOutputTokens: TokenCountSchema.optional(),
  reasoningOutputTokens: TokenCountSchema.optional(),
  audioDurationMs: TokenCountSchema.optional().describe(
    "Audio content duration in milliseconds; not billed duration."
  ),
  imageOutputTokens: TokenCountSchema.optional().describe(
    "Output tokens that encode generated images, within outputTokens."
  ),
  audioOutputTokens: TokenCountSchema.optional().describe(
    "Output tokens that encode generated audio, within outputTokens."
  ),
  outputImages: TokenCountSchema.optional().describe("Images the call returned."),
  inputCharacters: TokenCountSchema.optional().describe(
    "Input characters, counted by the provider's own billing rule."
  ),
  reportingStatus: z.enum(["complete", "partial", "unavailable"]),
})
