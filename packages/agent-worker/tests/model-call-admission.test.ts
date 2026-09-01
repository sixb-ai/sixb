import { describe, expect, test } from "bun:test"
import {
  AI_MODEL_CALL_OUTPUT_TOKEN_ALLOWANCE,
  aiModelCallOutputTokenAllowance,
  estimateAiModelCallInputTokens,
  estimatedAiModelCallTotalTokens,
} from "../src/model-call-admission"

describe("AI model-call admission estimates", () => {
  test("produces the same estimate for the same prepared text request", () => {
    const request = {
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [{ name: "search", inputSchema: { type: "object" } }],
      responseFormat: undefined,
    }

    const first = estimateAiModelCallInputTokens(request)
    const second = estimateAiModelCallInputTokens(structuredClone(request))

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      status: "estimated",
      method: "utf8BytesDividedByFour",
    })
    if (first.status === "estimated") expect(first.tokens).toBeGreaterThan(0)
  })

  test("reports non-text model inputs as unavailable", () => {
    expect(
      estimateAiModelCallInputTokens({
        prompt: [
          {
            role: "user",
            content: [{ type: "file", mediaType: "image/png", data: "base64" }],
          },
        ],
        tools: undefined,
        responseFormat: undefined,
      })
    ).toEqual({ status: "unavailable", reason: "nonTextInput" })
  })

  test("uses one internal output allowance without exposing a required setting", () => {
    const estimate = estimateAiModelCallInputTokens({
      prompt: [{ role: "user", content: "hello" }],
      tools: undefined,
      responseFormat: undefined,
    })
    const allowance = aiModelCallOutputTokenAllowance(undefined)

    expect(allowance).toBe(AI_MODEL_CALL_OUTPUT_TOKEN_ALLOWANCE)
    expect(estimatedAiModelCallTotalTokens(estimate, allowance)).toBe(
      estimate.status === "estimated" ? estimate.tokens + allowance : undefined
    )
  })
})
