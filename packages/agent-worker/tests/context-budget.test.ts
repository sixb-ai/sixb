import { describe, expect, spyOn, test } from "bun:test"
import {
  defineLanguageModel,
  type LanguageModelDefinition,
  ModelCatalogUnavailableError,
} from "@sixb/core/models"
import { prepareAgentModel, resolveAgentContextBudget } from "../src/context-budget"
import { WorkerTestModel } from "./worker-model-fixture"

function selection(limits: Partial<LanguageModelDefinition> = {}) {
  return {
    model: new WorkerTestModel({
      definition: defineLanguageModel({
        kind: "language",
        providerId: "mock",
        modelId: "model",
        capabilities: {},
        ...limits,
      }),
    }),
  }
}

describe("agent context budget resolution", () => {
  test("uses each agent's output reserve as its execution ceiling", async () => {
    // Removal proof: store the unbounded model in prepareAgentModel; requests exceed the reserve.
    const base = selection({ contextWindow: 32_768, maxOutputTokens: 16_384 })
    const outputs: (number | undefined)[] = []
    base.model.stream = async (request) => {
      outputs.push(request.maxOutputTokens)
      return { events: (async function* () {})() }
    }
    const prepared = await Promise.all(
      [base, { ...base, reasoning: { budgetTokens: 10_000 } }].map(prepareAgentModel)
    )
    for (const { model, budget } of prepared) {
      await model.stream({
        callId: "call",
        tools: [],
        messages: [],
        signal: new AbortController().signal,
      })
      expect(outputs.at(-1)! + budget.inputBudgetTokens).toBeLessThanOrEqual(32_768)
    }
    expect(outputs).toEqual([8_192, 10_001])
    await expect(
      prepareAgentModel({
        ...selection({ contextWindow: 32_768, maxOutputTokens: 8_192 }),
        reasoning: { budgetTokens: 10_000 },
      })
    ).rejects.toThrow("reasoning")
  })
  test("pins custom metadata and clamps execution to its resolved output ceiling", async () => {
    // Regression proof: store the original model instead of the bounded prepared model.
    const base = selection()
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
    const prepared = await prepareAgentModel({ ...base, model })
    const resolved = prepared.model
    expect(resolved.definition.capabilities.inputMediaTypes).toEqual(["image/png"])
    expect(prepared.budget.windowTokens).toBe(resolved.definition.contextWindow!)
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
      resolveAgentContextBudget(selection({ contextWindow: 1_050_000, maxInputTokens: 922_000 }))
    ).toEqual({
      windowTokens: 1_050_000,
      inputBudgetTokens: 922_000,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      source: "model",
    })
  })

  test("reserves space conservatively when only an input limit is known", () => {
    expect(resolveAgentContextBudget(selection({ maxInputTokens: 32_000 }))).toMatchObject({
      windowTokens: 32_000,
      inputBudgetTokens: 24_000,
      source: "model",
    })
  })

  // Regression proof: remove the fallback in resolveAgentContextBudget.
  test("uses the 128k fallback only when no model limit is available", () => {
    expect(resolveAgentContextBudget(selection())).toEqual({
      windowTokens: 128_000,
      inputBudgetTokens: 111_616,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      source: "fallback",
    })
  })

  test("rejects reasoning budgets that exhaust the context window", () => {
    expect(() =>
      resolveAgentContextBudget({
        ...selection({ contextWindow: 10_000 }),
        reasoning: { budgetTokens: 10_000 },
      })
    ).toThrow("reserveTokens must be less than the resolved context window")
  })

  // Regression proof: skip model resolution and the discovered window is lost.
  test("resolves model metadata without mutating the configured binding", async () => {
    const base = selection()
    let calls = 0
    const model = Object.assign(base.model, {
      resolve: async () => {
        calls += 1
        return new WorkerTestModel({
          definition: defineLanguageModel({ ...base.model.definition, contextWindow: 32_000 }),
        })
      },
    })
    const { budget } = await prepareAgentModel({ ...base, model })
    expect(calls).toBe(1)
    expect(budget.inputBudgetTokens).toBe(24_000)
    expect(model.definition.contextWindow).toBeUndefined()
  })

  test("does not conflate different bindings of the same provider and model", async () => {
    const bindings = [32_000, 64_000].map((contextWindow, index) => {
      const base = selection()
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
    const prepared = await Promise.all(bindings.map(prepareAgentModel))
    expect(prepared.map(({ budget }) => budget.windowTokens)).toEqual([32_000, 64_000])
  })

  test("starts offline with sufficient local metadata", async () => {
    let calls = 0
    for (const base of [
      selection({ contextWindow: 32_000 }),
      selection({ maxInputTokens: 32_000 }),
    ]) {
      const model = Object.assign(base.model, {
        resolve: async (options?: { offline?: boolean }) => {
          if (options?.offline) return base.model
          calls += 1
          throw new Error("offline")
        },
      })
      expect((await prepareAgentModel({ ...base, model })).budget.windowTokens).toBe(32_000)
    }
    expect(calls).toBe(0)
  })

  // Regression proof: let remote resolution errors bypass offline recovery, or remove the warning.
  test.each([
    false,
    true,
  ])("starts and warns once per model (catalog unavailable: %s)", async (unavailable) => {
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    const base = selection()
    try {
      const modes: (boolean | undefined)[] = []
      const model = Object.assign(base.model, {
        resolve: async (options?: { offline?: boolean }) => {
          modes.push(options?.offline)
          if (unavailable && !options?.offline) throw new ModelCatalogUnavailableError("offline")
          return base.model
        },
      })
      const prepared = await prepareAgentModel({ ...base, model })
      expect(prepared.budget.source).toBe("fallback")
      expect(prepared.model.definition.maxOutputTokens).toBe(16_384)
      expect(modes).toEqual(unavailable ? [false, true] : [false])
      expect(warning).toHaveBeenCalledTimes(1)
      expect(warning.mock.calls[0]?.[0]).toContain("128,000")
      expect(warning.mock.calls[0]?.[0]).toContain("mock/model")
    } finally {
      warning.mockRestore()
    }
  })

  test("rejects invalid definitions, arbitrary resolver failures, and mismatched identities", async () => {
    const base = selection()
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
      await expect(prepareAgentModel({ ...base, model })).rejects.toThrow()
    }
    const invalid = selection()
    Object.assign(invalid.model, { definition: { ...invalid.model.definition, contextWindow: -1 } })
    await expect(prepareAgentModel(invalid)).rejects.toThrow()
  })
})
