import { describe, expect, test } from "bun:test"
import type { ModelUsage } from "../src/models/events"
import { aiModelCallUsageFromModel } from "../src/models/execution/usage"

describe("model-call usage adapter", () => {
  test("preserves every available provider-neutral usage count", () => {
    const usage: ModelUsage = {
      inputTokens: 12,
      outputTokens: 8,
      uncachedInputTokens: 9,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 1,
      textOutputTokens: 6,
      reasoningOutputTokens: 2,
    }
    expect(aiModelCallUsageFromModel(usage)).toEqual(usage)
    expect(aiModelCallUsageFromModel({})).toEqual({})
  })
})
