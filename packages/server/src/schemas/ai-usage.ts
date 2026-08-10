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
  reportingStatus: z.enum(["complete", "partial", "unavailable"]),
})
