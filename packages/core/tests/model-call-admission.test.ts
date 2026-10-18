import { describe, expect, test } from "bun:test"
import {
  AI_MODEL_CALL_OUTPUT_TOKEN_ALLOWANCE,
  aiModelCallOutputTokenAllowance,
  estimateAiModelCallInputTokens,
  estimatedAiModelCallTotalTokens,
} from "../src/models/execution/model-call-admission"

describe("AI model-call admission estimates", () => {
  test("estimates a text request from its UTF-8 bytes and adds the internal output allowance", () => {
    // The prepared request serializes to 68 characters but 72 UTF-8 bytes.
    const estimate = estimateAiModelCallInputTokens({
      prompt: [{ role: "user", content: [{ type: "text", text: "日本" }] }],
      tools: undefined,
      responseFormat: undefined,
    })
    const allowance = aiModelCallOutputTokenAllowance(undefined)

    expect(estimate).toEqual({ status: "estimated", tokens: 18, method: "utf8BytesDividedByFour" })
    expect(allowance).toBe(AI_MODEL_CALL_OUTPUT_TOKEN_ALLOWANCE)
    expect(estimatedAiModelCallTotalTokens(estimate, allowance)).toBe(18 + 4_096)
  })

  test("reports non-text model inputs as unavailable instead of free", () => {
    const estimate = estimateAiModelCallInputTokens({
      prompt: [
        {
          role: "user",
          content: [{ type: "file", mediaType: "image/png", data: "base64" }],
        },
      ],
      tools: undefined,
      responseFormat: undefined,
    })

    expect(estimate).toEqual({ status: "unavailable", reason: "nonTextInput" })
    expect(estimatedAiModelCallTotalTokens(estimate, 4_096)).toBeUndefined()
  })
})
