import type { AiModelCallUsageInput } from "../../storage"
import type { ModelUsage } from "../events"

/** Map one provider-neutral model call into Sixb's durable accounting vocabulary. */
export function aiModelCallUsageFromModel(usage: ModelUsage): AiModelCallUsageInput {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.uncachedInputTokens === undefined
      ? {}
      : { uncachedInputTokens: usage.uncachedInputTokens }),
    ...(usage.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: usage.cacheReadInputTokens }),
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
    ...(usage.textOutputTokens === undefined ? {} : { textOutputTokens: usage.textOutputTokens }),
    ...(usage.reasoningOutputTokens === undefined
      ? {}
      : { reasoningOutputTokens: usage.reasoningOutputTokens }),
  }
}
