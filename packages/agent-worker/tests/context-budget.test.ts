import { describe, expect, spyOn, test } from "bun:test"
import type { AgentContextConfig } from "@sixb/core"
import {
  defineLanguageModel,
  type LanguageModelDefinition,
  ModelCatalogUnavailableError,
} from "@sixb/core/models"
import { prepareAgentModels, resolveAgentContextBudget } from "../src/context-budget"
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
  test("uses each agent's output reserve as its execution ceiling", async () => {
    // Removal proof: store the unbounded model in prepareAgentModels; requests exceed the reserve.
    const base = agent({ contextWindow: 32_768, maxOutputTokens: 16_384 })
    const outputs: (number | undefined)[] = []
    base.model.stream = async (request) => {
      outputs.push(request.maxOutputTokens)
      return { events: (async function* () {})() }
    }
    const prepared = await prepareAgentModels([
      base,
      { ...base, id: "reasoner", reasoning: { budgetTokens: 10_000 } },
    ])
    for (const id of [base.id, "reasoner"]) {
      const model = prepared.models.get(id)!
      const budget = prepared.budgets.get(id)!
      await model.stream({
        callId: id,
        tools: [],
        messages: [],
        signal: new AbortController().signal,
      })
      expect(outputs.at(-1)! + budget.inputBudgetTokens).toBeLessThanOrEqual(32_768)
    }
    expect(outputs).toEqual([8_192, 10_001])
    await expect(
      prepareAgentModels([
        {
          ...base,
          reasoning: { budgetTokens: 10_000 },
          loop: { context: { reserveTokens: 8_192 } },
        },
      ])
    ).rejects.toThrow("reasoning")
  })
  test("pins custom metadata and clamps execution to its resolved output ceiling", async () => {
    // Regression proof: store the original model instead of the bounded prepared model.
    const base = agent()
    const outputs: (number | undefined)[] = []
    const model = {
      ...base.model,
      providerId: base.model.providerId,
      modelId: base.model.modelId,
      definition: base.model.definition,
      resolve: async () => ({
        ...model,
        stream: model.stream.bind(model),
        definition: defineLanguageModel({
          ...base.model.definition,
          contextWindow: 32_000,
          maxOutputTokens: 400,
          capabilities: { inputMediaTypes: ["image/png"] },
        }),
      }),
      async stream(request: import("@sixb/core/models").LanguageModelRequest) {
        expect(this).toBe(model)
        outputs.push(request.maxOutputTokens)
        return { events: (async function* () {})() }
      },
    }
    const prepared = await prepareAgentModels([{ ...base, model }])
    const resolved = prepared.models.get(base.id)!
    expect(resolved.definition.capabilities.inputMediaTypes).toEqual(["image/png"])
    expect(prepared.budgets.get(base.id)?.windowTokens).toBe(resolved.definition.contextWindow!)
    for (const maxOutputTokens of [undefined, 100, 900]) {
      await resolved.stream({
        callId: "test",
        tools: [],
        messages: [],
        signal: new AbortController().signal,
        maxOutputTokens,
      })
    }
    expect(outputs).toEqual([400, 100, 400])
    expect(model.definition.contextWindow).toBeUndefined()
  })
  // Regression proof: remove maxInputTokens from the budget calculation.
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

  // Regression proof: remove the fallback in resolveAgentContextBudget.
  test("uses the 128k fallback only when no model limit or override is available", () => {
    expect(resolveAgentContextBudget(agent())).toEqual({
      windowTokens: 128_000,
      inputBudgetTokens: 111_616,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      source: "fallback",
    })
  })

  test("rejects overrides that cannot produce a safe input budget", () => {
    expect(() =>
      resolveAgentContextBudget(agent({}, { windowTokens: 10_000, reserveTokens: 10_000 }))
    ).toThrow("reserveTokens must be less than the resolved context window")
    expect(() =>
      resolveAgentContextBudget(agent({}, { windowTokens: 10_000, keepRecentTokens: 9_000 }))
    ).toThrow("keepRecentTokens must be less than the resolved input budget")
  })

  // Regression proof: skip model resolution or remove its per-instance cache.
  test("resolves shared model instances once with separate budgets for each agent", async () => {
    const base = agent()
    let calls = 0
    const model = Object.assign(base.model, {
      resolve: async () => {
        calls += 1
        return new WorkerTestModel({
          definition: defineLanguageModel({ ...base.model.definition, contextWindow: 32_000 }),
        })
      },
    })
    const { budgets } = await prepareAgentModels([
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
          resolve: async () =>
            new WorkerTestModel({
              definition: defineLanguageModel({ ...base.model.definition, contextWindow }),
            }),
        }),
      }
    })
    const { budgets } = await prepareAgentModels(bindings)
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
        resolve: async (options?: { offline?: boolean }) => {
          if (options?.offline) return base.model
          calls += 1
          throw new Error("offline")
        },
      })
      expect(
        (await prepareAgentModels([{ ...base, model }])).budgets.get("assistant")?.windowTokens
      ).toBe(32_000)
    }
    expect(calls).toBe(0)
  })

  // Regression proof: let remote resolution errors bypass offline recovery, or remove the warning.
  test.each([
    false,
    true,
  ])("starts and warns once per model (catalog unavailable: %s)", async (unavailable) => {
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    const base = agent()
    try {
      const modes: (boolean | undefined)[] = []
      const model = Object.assign(base.model, {
        resolve: async (options?: { offline?: boolean }) => {
          modes.push(options?.offline)
          if (unavailable && !options?.offline) throw new ModelCatalogUnavailableError("offline")
          return base.model
        },
      })
      const prepared = await prepareAgentModels([
        { ...base, model },
        { ...base, id: "other", model },
      ])
      expect(prepared.budgets.get(base.id)?.source).toBe("fallback")
      expect(prepared.models.get(base.id)?.definition.maxOutputTokens).toBe(16_384)
      expect(modes).toEqual(unavailable ? [false, true] : [false])
      expect(warning).toHaveBeenCalledTimes(1)
      expect(warning.mock.calls[0]?.[0]).toContain("128,000")
      expect(warning.mock.calls[0]?.[0]).toContain("mock/model")
    } finally {
      warning.mockRestore()
    }
  })

  test("rejects invalid definitions, arbitrary resolver failures, and mismatched identities", async () => {
    const base = agent()
    for (const resolve of [
      async () => {
        throw new Error("resolver bug")
      },
      async () =>
        new WorkerTestModel({
          definition: defineLanguageModel({
            ...base.model.definition,
            modelId: "wrong",
            contextWindow: 32_000,
          }),
        }),
    ]) {
      const model = Object.assign(base.model, { resolve })
      await expect(prepareAgentModels([{ ...base, model }])).rejects.toThrow()
    }
    const invalid = agent()
    Object.assign(invalid.model, { definition: { ...invalid.model.definition, contextWindow: -1 } })
    await expect(prepareAgentModels([invalid])).rejects.toThrow()
  })
})
