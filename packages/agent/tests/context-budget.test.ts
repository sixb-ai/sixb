import { describe, expect, spyOn, test } from "bun:test"
import { AGENT_CONTEXT_DEFAULT_BYTES_PER_TOKEN } from "@sixb/core/internal/agents"
import { resolveLanguageModel } from "@sixb/core/internal/model-execution"
import {
  defineLanguageModel,
  type LanguageModelDefinition,
  type LanguageModelRequest,
  ModelCatalogUnavailableError,
  type ModelFilePart,
  type ModelTextPart,
} from "@sixb/core/models"
import { prepareAgentModel, resolveAgentContextBudget } from "../src/context-budget"
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
    for (const bytes of [0, 300_000, 900_000]) await model.stream(request([text(bytes)]))

    expect(budget).toMatchObject({ reserveTokens: 16_384, inputBudgetTokens: 183_616 })
    expect(model.definition.maxOutputTokens).toBe(64_000)
    expect(outputs[0]).toBe(64_000)
    // 300,000 bytes count as 150,000 tokens at the 2 per token of a model no run measured yet,
    // plus a few overheads.
    expect(outputs[1]).toBeGreaterThan(49_900)
    expect(outputs[1]).toBeLessThan(50_000)
    expect(outputs[2]).toBe(16_384)
  })

  test("estimates each call like the conversation, at the rate its model's runs measured", async () => {
    // Removal proof: estimate the call by its serialized JSON, or ignore selection.bytesPerToken in
    // resolveAgentContextBudget; the escaped quotes double, or the call is weighed at the default
    // 2, and it asks for another output.
    const base = selection({
      modelId: "claude-haiku-5-5",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    })
    const outputs = recordOutputs(base.model)
    const { model, budget } = await pinAndPrepare({ ...base, bytesPerToken: 2.1 })
    await model.stream(request([{ type: "text", text: '"'.repeat(300_000) }]))

    expect(budget.bytesPerToken).toBe(2.1)
    // 300,000 bytes at the 2.1 per token measured, plus the request's and the message's 8 tokens.
    expect(outputs).toEqual([200_000 - (Math.ceil(300_000 / 2.1) + 16)])
  })

  test("starts a model no run measured at the default rate", async () => {
    // Removal proof: default resolveAgentContextBudget to 2.1 again, the Claude family rate; this
    // model then starts there.
    const { budget } = await pinAndPrepare(selection({ modelId: "claude-haiku-5-5" }))

    expect(budget.bytesPerToken).toBe(AGENT_CONTEXT_DEFAULT_BYTES_PER_TOKEN)
    expect(() => resolveAgentContextBudget({ ...selection(), bytesPerToken: 0 })).toThrow(
      "bytesPerToken must be a positive number"
    )
  })

  test("reports what each call measured of its model's tokenizer, for the run to record", async () => {
    // Removal proof: drop the `measured` call in prepareAgentModel; the run records nothing.
    const base = selection({ contextWindow: 200_000 })
    base.model.stream = async (request) => {
      const bytes = JSON.stringify(request.messages).length
      // The first call is too small to tell; the second counts 2.4 bytes per token.
      const inputTokens = bytes < 10_000 ? 100 : Math.ceil(30_000 / 2.4) + 16
      return {
        events: (async function* () {
          yield { type: "finish", finishReason: "stop", usage: { inputTokens, outputTokens: 10 } }
        })(),
      }
    }
    const samples: unknown[] = []
    const { model } = prepareAgentModel(
      { ...base, model: await resolveLanguageModel(base.model) },
      (sample) => samples.push(sample)
    )

    for (const bytes of [200, 30_000]) {
      for await (const _event of (await model.stream(request([text(bytes)]))).events) {
        // Read to the end, as the model loop does.
      }
    }

    expect(samples).toEqual([
      { providerId: "mock", modelId: "model", bytes: 30_000, tokens: 12_500 },
    ])
  })

  test("gives a long thread on an Anthropic model the room its window leaves", async () => {
    // Reproduce: size the ceiling at the run's starting rate less a quarter, as before; the second
    // call, about 130,000 real tokens of a 200,000 window, is then capped at the 16,384 reserve.
    const base = {
      ...selection({
        modelId: "claude-haiku-5-5",
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      }),
      // The densest the project's runs measured on the model lately.
      bytesPerToken: 2.1,
    }
    const outputs: (number | undefined)[] = []
    base.model.stream = async (request) => {
      outputs.push(request.maxOutputTokens)
      // This provider counts 2.4 bytes per token, as Anthropic models measured on agent turns.
      const bytes = request.messages.flatMap((message) =>
        message.role === "system"
          ? []
          : message.content.map((part) => (part.type === "text" ? part.text.length : 0))
      )
      const inputTokens = Math.ceil(bytes.reduce((total, value) => total + value, 0) / 2.4)
      return {
        events: (async function* () {
          yield { type: "finish", finishReason: "stop", usage: { inputTokens, outputTokens: 10 } }
        })(),
      }
    }
    const { model } = await pinAndPrepare(base)

    for (const bytes of [300_000, 312_000]) {
      for await (const _event of (await model.stream(request([text(bytes)]))).events) {
        // Read to the end, as the model loop does.
      }
    }

    // About 130,000 real tokens: weighed at the run's 2.1, denser than the 2.4 the first call
    // measured, they leave more than three times the reserve.
    expect(outputs[0]).toBeGreaterThan(16_384)
    expect(outputs[1]).toBe(200_000 - (Math.ceil(312_000 / 2.1) + 16))
  })

  test("never lets input and allowance pass the window when a call reads denser than measured", async () => {
    // Reproduce: weigh the request at the measured rate alone in prepareAgentModel; the call after
    // the large result is then given the whole 64,000-token cap, about 21,000 past the window.
    const base = {
      ...selection({
        modelId: "claude-haiku-5-5",
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      }),
      // What the project's runs measured on the model: its large tool results read at 2.1.
      bytesPerToken: 2.1,
    }
    const calls: { readonly inputTokens: number; readonly maxOutputTokens?: number }[] = []
    base.model.stream = async (request) => {
      const bytes = request.messages
        .flatMap((message) =>
          message.role === "system"
            ? []
            : message.content.map((part) => (part.type === "text" ? part.text.length : 0))
        )
        .reduce((total, value) => total + value, 0)
      // Conversation text at 2.6 bytes per token; the large tool result after it at 2.1.
      const inputTokens = calls.length === 0 ? Math.ceil(bytes / 2.6) : Math.ceil(bytes / 2.1)
      calls.push({ inputTokens, maxOutputTokens: request.maxOutputTokens })
      return {
        events: (async function* () {
          yield { type: "finish", finishReason: "stop", usage: { inputTokens, outputTokens: 10 } }
        })(),
      }
    }
    const { model } = await pinAndPrepare(base)

    for (const bytes of [100_000, 330_000]) {
      for await (const _event of (await model.stream(request([text(bytes)]))).events) {
        // Read to the end, as the model loop does.
      }
    }

    const after = calls[1]!
    expect(after.inputTokens + (after.maxOutputTokens ?? 0)).toBeLessThanOrEqual(200_000)
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
    },
    {
      limits: "only an input limit, which it treats as a conservative window",
      definition: { maxInputTokens: 32_000 },
      budget: {
        windowTokens: 32_000,
        inputBudgetTokens: 24_000,
        reserveTokens: 8_000,
        keepRecentTokens: 12_000,
      },
    },
    {
      limits: "no model limit, which falls back to 128k",
      definition: {},
      budget: { windowTokens: 128_000, inputBudgetTokens: 111_616, source: "fallback" },
    },
  ] as const)("derives the budget from $limits", ({ definition, budget }) => {
    expect(resolveAgentContextBudget(selection(definition))).toMatchObject({
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      source: "model",
      ...budget,
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
