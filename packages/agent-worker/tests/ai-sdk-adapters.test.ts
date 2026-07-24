import { describe, expect, test } from "bun:test"
import type { LanguageModelUsage } from "ai"
import { agentRunUsageFromAiSdk, agentTraceFromAiSdkSteps } from "../src/ai-sdk-adapters"

describe("AI SDK agent adapters", () => {
  test("converts ordered step content into the durable Sixb trace", () => {
    const trace = agentTraceFromAiSdkSteps([
      {
        content: [
          { type: "reasoning", text: "I should search." },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "search",
            input: { query: "active projects" },
          },
          {
            type: "tool-result",
            toolCallId: "call-1",
            output: { projects: ["project-1"] },
          },
          { type: "text", text: "Found it." },
        ],
      },
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-2",
            toolName: "lookup",
            input: { id: "missing" },
            dynamic: true,
          },
          {
            type: "tool-error",
            toolCallId: "call-2",
            error: new Error("Not found"),
          },
        ],
      },
    ])

    expect(trace).toEqual([
      { type: "step-start" },
      { type: "reasoning", text: "I should search." },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "search",
        input: { query: "active projects" },
        state: "output-available",
        output: { projects: ["project-1"] },
      },
      { type: "text", text: "Found it." },
      { type: "step-start" },
      {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "lookup",
        input: { id: "missing" },
        dynamic: true,
        state: "output-error",
        errorText: "Not found",
      },
    ])
  })

  test("rejects unsupported or non-JSON trace content instead of silently losing fidelity", () => {
    expect(() => agentTraceFromAiSdkSteps([{ content: [{ type: "source" }] }])).toThrow(
      "trace content 'source' is not supported"
    )

    expect(() =>
      agentTraceFromAiSdkSteps([
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "search",
              input: {},
            },
            { type: "tool-result", toolCallId: "call-1", output: 1n },
          ],
        },
      ])
    ).toThrow("tool output must be a JSON value")
  })

  test("maps AI SDK usage once into the provider-independent storage contract", () => {
    expect(
      agentRunUsageFromAiSdk(
        usage({
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
          cachedInputTokens: 3,
          reasoningTokens: 2,
        })
      )
    ).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      cachedInputTokens: 3,
      reasoningTokens: 2,
    })

    expect(agentRunUsageFromAiSdk(usage({}))).toBeUndefined()
  })
})

function usage(input: {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cachedInputTokens?: number
  readonly reasoningTokens?: number
}): LanguageModelUsage {
  return {
    inputTokens: input.inputTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: input.cachedInputTokens,
      cacheWriteTokens: undefined,
    },
    outputTokens: input.outputTokens,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: input.reasoningTokens,
    },
    totalTokens: input.totalTokens,
  }
}
