import { describe, expect, test } from "bun:test"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import { withAutomaticPromptCaching } from "../src/provider-caching"

function model(provider: string): LanguageModelV4 {
  return { specificationVersion: "v4", provider, modelId: "model" } as LanguageModelV4
}

describe("withAutomaticPromptCaching", () => {
  test("enables the Gateway automatic caching path and preserves project options", () => {
    expect(
      withAutomaticPromptCaching(model("gateway"), {
        gateway: {
          zeroDataRetention: true,
          disallowPromptTraining: true,
        },
      })
    ).toEqual({
      gateway: {
        caching: "auto",
        zeroDataRetention: true,
        disallowPromptTraining: true,
      },
    })
  })

  test("preserves an explicit project caching value", () => {
    const configured = {
      gateway: {
        caching: "auto",
        zeroDataRetention: true,
      },
    }

    expect(withAutomaticPromptCaching(model("gateway.language-model"), configured)).toBe(configured)
  })

  test("does not add Gateway options to direct providers", () => {
    const configured = { anthropic: { serviceTier: "standard" } }

    expect(withAutomaticPromptCaching(model("anthropic.messages"), configured)).toBe(configured)
    expect(withAutomaticPromptCaching(model("openai.responses"), undefined)).toBeUndefined()
  })
})
