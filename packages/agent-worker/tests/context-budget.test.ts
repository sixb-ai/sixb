import { describe, expect, test } from "bun:test"
import {
  DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
  resolveAgentContextBudget,
} from "../src/context-budget"
import { resolveModelsDevContextLimits } from "../src/models-dev/catalog"

function resolveBudget(provider: string, modelId: string) {
  return resolveAgentContextBudget(resolveModelsDevContextLimits({ provider, modelId }))
}

describe("agent context budget resolution", () => {
  test("uses the exact Models.dev context and input limits", () => {
    expect(resolveBudget("openai.responses", "gpt-5.4")).toEqual({
      windowTokens: 1_050_000,
      inputBudgetTokens: 922_000,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      source: "models.dev",
    })
  })

  test("maps reviewed AI SDK provider namespaces without fuzzy model matching", () => {
    expect(resolveBudget("gateway", "openai/gpt-5.4")).toMatchObject({
      windowTokens: 1_050_000,
      source: "models.dev",
    })
    expect(resolveBudget("openai.responses.extra", "gpt-5.4")).toEqual({
      windowTokens: DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
      inputBudgetTokens: 111_616,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      source: "fallback",
    })
  })

  test("bounds retention and reserve for small context windows", () => {
    expect(resolveAgentContextBudget({ contextTokens: 4000 })).toMatchObject({
      windowTokens: 4000,
      reserveTokens: 1000,
      inputBudgetTokens: 3000,
      keepRecentTokens: 1500,
    })
  })
})
