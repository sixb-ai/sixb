import { describe, expect, test } from "bun:test"
import { aggregateAiModelCallUsage } from "../src/storage"
import { normalizeAiModelCallUsage } from "../src/storage/ai-usage/usage"

const ZERO_REPORT = {
  inputTokens: 0,
  outputTokens: 0,
  uncachedInputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  textOutputTokens: 0,
  reasoningOutputTokens: 0,
}

describe("AI model-call usage vocabulary", () => {
  test.each([
    {
      name: "a complete report without double-counting details",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        uncachedInputTokens: 9,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 2,
        textOutputTokens: 6,
        reasoningOutputTokens: 2,
      },
      expected: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        uncachedInputTokens: 9,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 2,
        textOutputTokens: 6,
        reasoningOutputTokens: 2,
        reportingStatus: "complete",
      },
    },
    {
      name: "reported zeroes",
      usage: ZERO_REPORT,
      expected: { ...ZERO_REPORT, totalTokens: 0, reportingStatus: "complete" },
    },
    {
      name: "detail fields that do not sum to their totals",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        uncachedInputTokens: 10,
        cacheReadInputTokens: 4,
        reasoningOutputTokens: 3,
      },
      expected: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        uncachedInputTokens: 10,
        cacheReadInputTokens: 4,
        reasoningOutputTokens: 3,
        reportingStatus: "complete",
      },
    },
    { name: "no report", usage: {}, expected: { reportingStatus: "unavailable" } },
    {
      name: "a missing output count",
      usage: { inputTokens: 0 },
      expected: { inputTokens: 0, reportingStatus: "partial" },
    },
    {
      name: "a detail without totals",
      usage: { cacheReadInputTokens: 0 },
      expected: { cacheReadInputTokens: 0, reportingStatus: "partial" },
    },
  ])("normalizes $name", ({ usage, expected }) => {
    expect(normalizeAiModelCallUsage(usage)).toEqual(expected)
  })

  test.each([
    {
      name: "sums exact fields across complete calls",
      calls: [
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
      ],
      expected: {
        inputTokens: 16,
        outputTokens: 14,
        totalTokens: 30,
        uncachedInputTokens: 13,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 3,
        textOutputTokens: 11,
        reasoningOutputTokens: 3,
        reportingStatus: "complete",
      },
    },
    {
      name: "keeps only fields every call reported",
      calls: [
        { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
        { inputTokens: 4, uncachedInputTokens: 4 },
      ],
      expected: { inputTokens: 14, reportingStatus: "partial" },
    },
    {
      name: "does not turn a call without usage into zeroes",
      calls: [{ inputTokens: 10, outputTokens: 5 }, {}],
      expected: { reportingStatus: "partial" },
    },
    {
      name: "reports no calls as unavailable",
      calls: [],
      expected: { reportingStatus: "unavailable" },
    },
  ])("aggregate $name", ({ calls, expected }) => {
    expect(aggregateAiModelCallUsage(calls)).toEqual(expected)
  })

  test("rejects invalid counts and totals or sums outside the safe integer range", () => {
    for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => normalizeAiModelCallUsage({ inputTokens: invalid })).toThrow(
        "inputTokens must be a non-negative safe integer"
      )
    }
    expect(() =>
      normalizeAiModelCallUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 })
    ).toThrow("totalTokens exceeds the safe integer range")
    expect(() =>
      aggregateAiModelCallUsage([{ inputTokens: Number.MAX_SAFE_INTEGER }, { inputTokens: 1 }])
    ).toThrow("aggregate inputTokens exceeds the safe integer range")
  })
})
