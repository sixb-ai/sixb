import { describe, expect, test } from "bun:test"
import type { AgentContextConfig } from "@sixb/core"
import { defineLanguageModel, type LanguageModelDefinition } from "@sixb/core/models"
import { resolveAgentContextBudget, resolveAgentContextBudgets } from "../src/context-budget"
import { WorkerTestModel } from "./worker-model-fixture"

function agent(limits: Partial<LanguageModelDefinition> = {}, context?: AgentContextConfig) {
  return {
    id: "assistant",
    model: new WorkerTestModel({
      definition: defineLanguageModel({
        kind: "language",
        providerId: "mock",
        modelId: "model",
        capabilities: {},
        ...limits,
      }),
    }),
    ...(context === undefined ? {} : { loop: { context } }),
  }
}

describe("agent context budget resolution", () => {
  // Regression proof: remove maxInputTokens from the budget calculation or restore the fixed fallback.
  test("respects separate context and input limits", () => {
    expect(
      resolveAgentContextBudget(agent({ contextWindow: 1_050_000, maxInputTokens: 922_000 }))
    ).toEqual({
      windowTokens: 1_050_000,
      inputBudgetTokens: 922_000,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      source: "model",
    })
  })

  test("reserves space conservatively when only an input limit is known", () => {
    expect(resolveAgentContextBudget(agent({ maxInputTokens: 32_000 }))).toMatchObject({
      windowTokens: 32_000,
      inputBudgetTokens: 24_000,
      source: "model",
    })
  })

  test("treats an explicit window as authoritative", () => {
    expect(
      resolveAgentContextBudget(
        agent({ contextWindow: 32_000, maxInputTokens: 24_000 }, { windowTokens: 1_500_000 })
      )
    ).toEqual({
      windowTokens: 1_500_000,
      inputBudgetTokens: 1_483_616,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      source: "config",
    })
  })

  test("applies advanced overrides to a model-derived window", () => {
    expect(
      resolveAgentContextBudget(
        agent(
          { contextWindow: 1_050_000, maxInputTokens: 922_000 },
          { reserveTokens: 200_000, keepRecentTokens: 10_000 }
        )
      )
    ).toMatchObject({ inputBudgetTokens: 850_000, keepRecentTokens: 10_000, source: "model" })
  })

  test("rejects unknown limits rather than assuming a window", () => {
    expect(() => resolveAgentContextBudget(agent())).toThrow("loop.context.windowTokens")
  })

  test("rejects overrides that cannot produce a safe input budget", () => {
    expect(() =>
      resolveAgentContextBudget(agent({}, { windowTokens: 10_000, reserveTokens: 10_000 }))
    ).toThrow("reserveTokens must be less than the resolved context window")
    expect(() =>
      resolveAgentContextBudget(agent({}, { windowTokens: 10_000, keepRecentTokens: 9_000 }))
    ).toThrow("keepRecentTokens must be less than the resolved input budget")
  })

  // Regression proof: skip the resolver in resolveAgentContextBudgets or remove its per-instance cache.
  test("resolves shared model instances once with separate budgets for each agent", async () => {
    const base = agent()
    let calls = 0
    const model = Object.assign(base.model, {
      resolveDefinition: async () => {
        calls += 1
        return defineLanguageModel({ ...base.model.definition, contextWindow: 32_000 })
      },
    })
    const budgets = await resolveAgentContextBudgets([
      { ...base, model },
      { ...base, id: "other", model, loop: { context: { reserveTokens: 4_000 } } },
    ])
    expect(calls).toBe(1)
    expect(budgets.get("assistant")?.inputBudgetTokens).toBe(24_000)
    expect(budgets.get("other")?.inputBudgetTokens).toBe(28_000)
    expect(model.definition.contextWindow).toBeUndefined()
  })

  test("does not conflate different bindings of the same provider and model", async () => {
    const bindings = [32_000, 64_000].map((contextWindow, index) => {
      const base = agent()
      return {
        ...base,
        id: `agent-${index}`,
        model: Object.assign(base.model, {
          resolveDefinition: async () =>
            defineLanguageModel({ ...base.model.definition, contextWindow }),
        }),
      }
    })
    const budgets = await resolveAgentContextBudgets(bindings)
    expect([...budgets.values()].map((budget) => budget.windowTokens)).toEqual([32_000, 64_000])
  })

  test("starts offline with an explicit override or sufficient local metadata", async () => {
    let calls = 0
    for (const base of [
      agent({}, { windowTokens: 32_000 }),
      agent({ contextWindow: 32_000 }),
      agent({ maxInputTokens: 32_000 }),
    ]) {
      const model = Object.assign(base.model, {
        resolveDefinition: async () => {
          calls += 1
          throw new Error("offline")
        },
      })
      expect(
        (await resolveAgentContextBudgets([{ ...base, model }])).get("assistant")?.windowTokens
      ).toBe(32_000)
    }
    expect(calls).toBe(0)
  })

  test("fails clearly on unknown models, catalog failures, and mismatched identities", async () => {
    const base = agent()
    await expect(resolveAgentContextBudgets([base])).rejects.toThrow("mock/model")
    for (const resolveDefinition of [
      async () => base.model.definition,
      async () => {
        throw new Error("catalog unavailable")
      },
      async () =>
        defineLanguageModel({ ...base.model.definition, modelId: "wrong", contextWindow: 32_000 }),
    ]) {
      const model = Object.assign(base.model, { resolveDefinition })
      await expect(resolveAgentContextBudgets([{ ...base, model }])).rejects.toThrow(
        "loop.context.windowTokens"
      )
    }
  })
})
