import { describe, expect, spyOn, test } from "bun:test"
import { resolveLanguageModel } from "@sixb/core/internal/model-execution"
import {
  defineLanguageModel,
  type LanguageModelDefinition,
  type LanguageModelRequest,
  ModelCatalogUnavailableError,
  type ModelFilePart,
  type ModelRateCard,
  type ModelTextPart,
} from "@sixb/core/models"
import {
  expectedRemainingAgentCalls,
  prepareAgentModel,
  resolveAgentContextBudget,
  resolveAgentContextTarget,
} from "../src/context-budget"
import { WorkerTestModel } from "./worker-model-fixture"

function selection(limits: Partial<LanguageModelDefinition> = {}, maxOutputTokens?: number) {
  return {
    model: new WorkerTestModel({
      definition: defineLanguageModel({
        kind: "language",
        providerId: "mock",
        modelId: "model",
        capabilities: {},
        ...limits,
      }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    }),
  }
}

function recordOutputs(model: WorkerTestModel): (number | undefined)[] {
  const outputs: (number | undefined)[] = []
  model.stream = async (request) => {
    outputs.push(request.maxOutputTokens)
    return { events: (async function* () {})() }
  }
  return outputs
}

function request(content: readonly (ModelTextPart | ModelFilePart)[] = []): LanguageModelRequest {
  return {
    callId: "call",
    tools: [],
    messages: [{ role: "user", content }],
    signal: new AbortController().signal,
  }
}

const text = (bytes: number): ModelTextPart => ({ type: "text", text: "a".repeat(bytes) })

/** A model as a session hands it over, pinned once, then budgeted by the harness. */
async function pinAndPrepare(selection: Parameters<typeof prepareAgentModel>[0]) {
  return prepareAgentModel({ ...selection, model: await resolveLanguageModel(selection.model) })
}

describe("agent context budget resolution", () => {
  test("gives each call what its input leaves of the window, never less than the reserve", async () => {
    // Removal proof: return capTokens from outputCeilingTokens; calls whose input fills the window
    // still ask for 64,000 tokens.
    const base = selection({ contextWindow: 200_000, maxOutputTokens: 64_000 })
    const outputs = recordOutputs(base.model)
    const { model, budget } = await pinAndPrepare(base)
    for (const bytes of [0, 360_000, 720_000]) await model.stream(request([text(bytes)]))

    expect(budget).toMatchObject({ reserveTokens: 16_384, inputBudgetTokens: 183_616 })
    expect(model.definition.maxOutputTokens).toBe(64_000)
    expect(outputs[0]).toBe(64_000)
    // 360,000 bytes count as 150,000 tokens at an unknown tokenizer's 3 per token less the
    // ceiling's quarter margin, plus a few overheads.
    expect(outputs[1]).toBeGreaterThan(49_900)
    expect(outputs[1]).toBeLessThan(50_000)
    expect(outputs[2]).toBe(16_384)
  })

  test("estimates each call like the conversation, at the model's tokenizer rate", async () => {
    // Removal proof: estimate the call by its serialized JSON, at a fixed two bytes per token, or
    // without the margin; the escaped quotes double, or the Claude rate is lost, and the call asks
    // for another output.
    const base = selection({
      modelId: "claude-haiku-5-5",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    })
    const outputs = recordOutputs(base.model)
    const { model } = await pinAndPrepare(base)
    await model.stream(request([{ type: "text", text: '"'.repeat(300_000) }]))

    // 300,000 bytes at Claude's 2.1 per token less a quarter, plus the request's and the
    // message's 8 tokens each.
    expect(outputs).toEqual([200_000 - (Math.ceil(300_000 / (2.1 / 1.25)) + 16)])
  })

  test("keeps a reasoning budget's reserve and rejects one the model cannot exceed", async () => {
    // Removal proof: drop the reasoning budget from the reserve; a full window leaves 8,192 tokens,
    // less than the reasoning alone.
    const base = {
      ...selection({ contextWindow: 32_768, maxOutputTokens: 16_384 }),
      reasoning: { budgetTokens: 10_000 },
    }
    const outputs = recordOutputs(base.model)
    const { model, budget } = await pinAndPrepare(base)
    await model.stream(request([text(90_000)]))

    expect(budget).toMatchObject({ reserveTokens: 10_001, inputBudgetTokens: 22_767 })
    expect(outputs).toEqual([10_001])
    await expect(
      pinAndPrepare({
        ...selection({ contextWindow: 32_768, maxOutputTokens: 8_192 }),
        reasoning: { budgetTokens: 10_000 },
      })
    ).rejects.toThrow("reasoning")
  })

  test("counts an attached image at its provider ceiling, never capping the call at the reserve", async () => {
    // Removal proof: return undefined from estimateRequestInputTokens when a user message holds a
    // file; every call of a thread with an attachment asks for the 16,384-token reserve.
    const base = selection({ contextWindow: 200_000, maxOutputTokens: 64_000 })
    const outputs = recordOutputs(base.model)
    const { model } = await pinAndPrepare(base)
    const image = (bytes: number): ModelFilePart => ({
      type: "file",
      data: new URL(`data:image/png;base64,${"A".repeat(bytes)}`),
      mediaType: "image/png",
    })
    const pdf: ModelFilePart = {
      type: "file",
      data: new URL(`data:application/pdf;base64,${"A".repeat(600_000)}`),
      mediaType: "application/pdf",
    }

    // A 4 MB image counts as 5,400 tokens, not 2,000,000; 30 of them as 162,000.
    await model.stream(request([image(4_000_000)]))
    await model.stream(request(Array.from({ length: 30 }, () => image(10))))
    // A document counts by its encoded bytes: 600,000 at 3 per token fill the window.
    await model.stream(request([pdf]))

    expect(outputs[0]).toBe(64_000)
    expect(outputs[1]).toBeGreaterThan(37_000)
    expect(outputs[1]).toBeLessThan(38_000)
    expect(outputs[2]).toBe(16_384)
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
    const prepared = await pinAndPrepare({ ...base, model })
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
  test("uses the binding's output limit as a cap that leaves the input budget alone", async () => {
    // Removal proof: reserve the binding's limit; the input budget drops to 168,000 tokens and the
    // 32,000-token window has none left.
    const base = selection({ contextWindow: 200_000, maxOutputTokens: 64_000 }, 32_000)
    const outputs = recordOutputs(base.model)
    const { model, budget } = await pinAndPrepare(base)
    await model.stream(request())

    expect(budget).toMatchObject({ reserveTokens: 16_384, inputBudgetTokens: 183_616 })
    expect(model.definition.maxOutputTokens).toBe(32_000)
    expect(outputs).toEqual([32_000])
    const fills = await pinAndPrepare(selection({ contextWindow: 32_000 }, 32_000))
    expect(fills.budget).toMatchObject({ reserveTokens: 8_000, inputBudgetTokens: 24_000 })
  })

  test("caps the binding's output limit at the resolved model maximum", async () => {
    // Removal proof: drop the `definition.maxOutputTokens` cap on the binding's limit; calls ask for
    // 32,000 tokens the model can never produce.
    const base = selection({}, 32_000)
    const model = Object.assign(base.model, {
      resolve: async () =>
        new WorkerTestModel({
          definition: defineLanguageModel({
            ...base.model.definition,
            contextWindow: 128_000,
            maxOutputTokens: 20_000,
          }),
          maxOutputTokens: 32_000,
        }),
    })
    const prepared = await pinAndPrepare({ model })
    expect(prepared.budget).toMatchObject({ reserveTokens: 16_384, inputBudgetTokens: 111_616 })
    expect(prepared.model.definition.maxOutputTokens).toBe(20_000)
  })

  // Regression proof: remove maxInputTokens from the budget calculation (first row), or the
  // fallback from resolveAgentContextBudget (last row).
  test.each([
    {
      limits: "separate context and input limits",
      definition: { contextWindow: 1_050_000, maxInputTokens: 922_000 },
      budget: { windowTokens: 1_050_000, inputBudgetTokens: 922_000, source: "model" },
      keepRecentTokens: 20_000,
    },
    {
      limits: "only an input limit, which it treats as a conservative window",
      definition: { maxInputTokens: 32_000 },
      budget: { windowTokens: 32_000, inputBudgetTokens: 24_000, reserveTokens: 8_000 },
      keepRecentTokens: 12_000,
    },
    {
      limits: "no model limit, which falls back to 128k",
      definition: {},
      budget: { windowTokens: 128_000, inputBudgetTokens: 111_616, source: "fallback" },
      keepRecentTokens: 20_000,
    },
  ] as const)("derives the budget from $limits", ({ definition, budget, keepRecentTokens }) => {
    const resolved = resolveAgentContextBudget(selection(definition))
    expect(resolved).toMatchObject({ reserveTokens: 16_384, source: "model", ...budget })
    expect(resolveAgentContextTarget(resolved).keepRecentTokens).toBe(keepRecentTokens)
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
  test("resolves each binding's metadata once, without mutating or conflating bindings", async () => {
    let calls = 0
    const bindings = [32_000, 64_000].map((contextWindow) => {
      const base = selection()
      return {
        ...base,
        model: Object.assign(base.model, {
          resolve: async () => {
            calls += 1
            return new WorkerTestModel({
              definition: defineLanguageModel({ ...base.model.definition, contextWindow }),
            })
          },
        }),
      }
    })
    const prepared = await Promise.all(bindings.map(pinAndPrepare))
    expect(calls).toBe(2)
    expect(prepared.map(({ budget }) => budget.inputBudgetTokens)).toEqual([24_000, 48_000])
    expect(bindings.map(({ model }) => model.definition.contextWindow)).toEqual([
      undefined,
      undefined,
    ])
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
      expect((await pinAndPrepare({ ...base, model })).budget.windowTokens).toBe(32_000)
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
      const prepared = await pinAndPrepare({ ...base, model })
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
      await expect(pinAndPrepare({ ...base, model })).rejects.toThrow()
    }
    const invalid = selection()
    Object.assign(invalid.model, { definition: { ...invalid.model.definition, contextWindow: -1 } })
    await expect(pinAndPrepare(invalid)).rejects.toThrow()
  })
})

/** An Anthropic-shaped card (cache reads 0.1×, writes 1.25×, output 5×) whose every meter rises. */
function tieredCard(input: {
  readonly ratio: number
  readonly fromTokens?: number
  readonly oneHourWrites?: boolean
}): ModelRateCard {
  const price = (base: number) => ({
    default: String(base),
    tiers: [{ minTokens: input.fromTokens ?? 200_001, price: String(base * input.ratio) }],
  })
  return {
    currency: "USD",
    input: price(1),
    output: price(5),
    cacheReadInput: price(0.1),
    ...(input.oneHourWrites
      ? { cacheWriteInput5m: price(1.25), cacheWriteInput1h: price(2) }
      : { cacheWriteInput: price(1.25) }),
  }
}

function priced(
  rateCard: ModelRateCard | undefined,
  limits: Partial<LanguageModelDefinition> = {}
) {
  const base = selection({ contextWindow: 1_000_000, maxOutputTokens: 128_000, ...limits })
  return { model: Object.assign(base.model, rateCard ? { rateCard } : {}) }
}

describe("agent context soft limit", () => {
  test("keeps the window when no price tier rises", () => {
    for (const card of [undefined, { currency: "USD", input: "4", output: "20" } as const]) {
      const budget = resolveAgentContextBudget(priced(card))
      expect(budget.priceTiers).toEqual([])
      expect(resolveAgentContextTarget(budget, { expectedRemainingCalls: 1_000 })).toEqual({
        tokens: 983_616,
        limit: "window",
        expectedRemainingCalls: 1_000,
        keepRecentTokens: 20_000,
      })
    }
  })

  // Removal proof: drop the rising-price check in contextPriceTiers; compacting to 60 % is always
  // cheaper in the long run, so a long enough thread stops at Gemini 3 Flash's 200k "tier".
  test("ignores a tier that bills the same price", () => {
    const budget = resolveAgentContextBudget(priced(tieredCard({ ratio: 1 })))

    expect(budget.priceTiers).toEqual([])
    expect(resolveAgentContextTarget(budget, { expectedRemainingCalls: 1_000 }).limit).toBe(
      "window"
    )
  })

  // Removal proof: compare breakEvenCalls with FRESH_THREAD_EXPECTED_CALLS alone (ignore the
  // expectation); the ×1.2 tier then never applies, however long the thread.
  test("stays under a ×1.2 tier only once enough calls remain to pay compaction back", () => {
    const budget = resolveAgentContextBudget(priced(tieredCard({ ratio: 1.2 })))
    const [tier] = budget.priceTiers

    expect(tier?.fromTokens).toBe(200_001)
    expect(tier?.priceRatio).toBeCloseTo(1.2)
    expect(tier?.breakEvenCalls).toBeCloseTo(32.58, 2)
    expect(resolveAgentContextTarget(budget, { expectedRemainingCalls: 32 })).toMatchObject({
      tokens: 983_616,
      limit: "window",
      tier,
    })
    expect(resolveAgentContextTarget(budget, { expectedRemainingCalls: 33 })).toMatchObject({
      tokens: 200_000,
      limit: "price-tier",
      tier,
    })
  })

  // Removal proof: set FRESH_THREAD_EXPECTED_CALLS to 0; a fresh thread then crosses Haiku 5.5's
  // ×5 tier, which pays back after 4.9 calls.
  test("assumes a fresh thread makes 8 more calls", () => {
    const fivefold = resolveAgentContextBudget(
      priced(tieredCard({ ratio: 5, fromTokens: 100_001 }))
    )
    const doubled = resolveAgentContextBudget(priced(tieredCard({ ratio: 2 })))

    expect(fivefold.priceTiers[0]?.breakEvenCalls).toBeCloseTo(4.91, 2)
    expect(resolveAgentContextTarget(fivefold)).toMatchObject({
      tokens: 100_000,
      limit: "price-tier",
      expectedRemainingCalls: 8,
    })
    // While the summary is a one-shot request, a ×2 tier takes 14 calls to repay.
    expect(doubled.priceTiers[0]?.breakEvenCalls).toBeCloseTo(13.96, 2)
    expect(resolveAgentContextTarget(doubled)).toMatchObject({ limit: "window" })
  })

  // Removal proof: price writes at cacheWriteInput5m first; the one-hour premium no longer counts
  // and a fresh thread compacts before a tier it may not stay long enough to repay.
  test("prices the rewrite at the one-hour cache write a conversation pays", () => {
    const budget = resolveAgentContextBudget(priced(tieredCard({ ratio: 2, oneHourWrites: true })))

    expect(budget.priceTiers[0]?.breakEvenCalls).toBeCloseTo(17.18, 2)
    expect(resolveAgentContextTarget(budget, { expectedRemainingCalls: 14 }).limit).toBe("window")
    expect(resolveAgentContextTarget(budget, { expectedRemainingCalls: 18 }).limit).toBe(
      "price-tier"
    )
  })

  // Removal proof: drop the `<= inputBudgetTokens` bound on tier boundaries; an 80k window
  // targets a 100k tier it can never reach.
  test("lets a project's contextWindow decide which tiers count", () => {
    const haiku = tieredCard({ ratio: 5, fromTokens: 100_001 })
    const roomy = resolveAgentContextBudget(priced(haiku, { contextWindow: 150_000 }))
    const small = resolveAgentContextBudget(priced(haiku, { contextWindow: 80_000 }))

    expect(resolveAgentContextTarget(roomy)).toMatchObject({ tokens: 100_000, limit: "price-tier" })
    expect(small.priceTiers).toEqual([])
    expect(resolveAgentContextTarget(small)).toMatchObject({ tokens: 63_616, limit: "window" })
  })

  test("expects as many turns again as a thread has had, each as long as its average", () => {
    const answer = (steps: number) => ({
      role: "assistant",
      parts: Array.from({ length: steps }, () => ({ type: "step-start" })),
    })
    const user = { role: "user", parts: [{ type: "text" }] }
    const turns = [user, answer(4), user, answer(4), user, answer(4), user]

    expect(expectedRemainingAgentCalls({ checkpoint: null, messages: [user] })).toBeUndefined()
    expect(expectedRemainingAgentCalls({ checkpoint: null, messages: turns })).toBe(16)
    // Five summarized turns before the checkpoint: 4 steps × (8 turns + this one).
    expect(
      expectedRemainingAgentCalls({ checkpoint: { summarizedThroughSeq: 10 }, messages: turns })
    ).toBe(36)
    // An answer stored without step markers is one call.
    expect(
      expectedRemainingAgentCalls({ checkpoint: null, messages: [user, answer(0), user] })
    ).toBe(2)
  })
})
