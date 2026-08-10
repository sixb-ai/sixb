import { describe, expect, test } from "bun:test"
import { aggregateAiModelCallUsage, normalizeAiModelCallUsage } from "../src/storage"

describe("AI model-call usage vocabulary", () => {
  test("normalizes a complete provider report without double-counting details", () => {
    expect(
      normalizeAiModelCallUsage({
        inputTokens: 12,
        outputTokens: 8,
        uncachedInputTokens: 9,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 2,
        textOutputTokens: 6,
        reasoningOutputTokens: 2,
      })
    ).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      uncachedInputTokens: 9,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 2,
      textOutputTokens: 6,
      reasoningOutputTokens: 2,
      reportingStatus: "complete",
    })
  })

  test("preserves reported zeroes and keeps missing counts unknown", () => {
    expect(
      normalizeAiModelCallUsage({
        inputTokens: 0,
        outputTokens: 0,
        uncachedInputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        textOutputTokens: 0,
        reasoningOutputTokens: 0,
      })
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      uncachedInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      textOutputTokens: 0,
      reasoningOutputTokens: 0,
      reportingStatus: "complete",
    })

    expect(normalizeAiModelCallUsage({})).toEqual({
      reportingStatus: "unavailable",
    })
    expect(normalizeAiModelCallUsage({ inputTokens: 0 })).toEqual({
      inputTokens: 0,
      reportingStatus: "partial",
    })
    expect(normalizeAiModelCallUsage({ cacheReadInputTokens: 0 })).toEqual({
      cacheReadInputTokens: 0,
      reportingStatus: "partial",
    })
  })

  test("does not require provider detail fields to sum to their totals", () => {
    expect(
      normalizeAiModelCallUsage({
        inputTokens: 10,
        outputTokens: 2,
        uncachedInputTokens: 10,
        cacheReadInputTokens: 4,
        reasoningOutputTokens: 3,
      })
    ).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      reportingStatus: "complete",
    })
  })

  test("rejects invalid counts and totals outside the safe integer range", () => {
    for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => normalizeAiModelCallUsage({ inputTokens: invalid })).toThrow(
        "inputTokens must be a non-negative safe integer"
      )
    }

    expect(() =>
      normalizeAiModelCallUsage({
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 1,
      })
    ).toThrow("totalTokens exceeds the safe integer range")
  })

  test("aggregates exact fields across model calls", () => {
    expect(
      aggregateAiModelCallUsage([
        {
          inputTokens: 12,
          outputTokens: 8,
          uncachedInputTokens: 9,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 1,
          textOutputTokens: 6,
          reasoningOutputTokens: 2,
        },
        {
          inputTokens: 4,
          outputTokens: 6,
          uncachedInputTokens: 4,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 2,
          textOutputTokens: 5,
          reasoningOutputTokens: 1,
        },
      ])
    ).toEqual({
      inputTokens: 16,
      outputTokens: 14,
      totalTokens: 30,
      uncachedInputTokens: 13,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 3,
      textOutputTokens: 11,
      reasoningOutputTokens: 3,
      reportingStatus: "complete",
    })
  })

  test("does not turn a missing call count into an aggregate zero", () => {
    expect(
      aggregateAiModelCallUsage([
        { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
        { inputTokens: 4, uncachedInputTokens: 4 },
      ])
    ).toEqual({
      inputTokens: 14,
      reportingStatus: "partial",
    })

    expect(aggregateAiModelCallUsage([{ inputTokens: 10, outputTokens: 5 }, {}])).toEqual({
      reportingStatus: "partial",
    })
    expect(aggregateAiModelCallUsage([])).toEqual({ reportingStatus: "unavailable" })
  })

  test("rejects aggregate sums outside the safe integer range", () => {
    expect(() =>
      aggregateAiModelCallUsage([{ inputTokens: Number.MAX_SAFE_INTEGER }, { inputTokens: 1 }])
    ).toThrow("aggregate inputTokens exceeds the safe integer range")
  })
})
