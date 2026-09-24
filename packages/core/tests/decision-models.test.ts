import { describe, expect, test } from "bun:test"
import { decisionOutput, question, SixbHost } from "../src"
import { bindRequestExecution } from "../src/execution/request"
import {
  createModelCatalog,
  type DecisionModel,
  type DecisionModelRequest,
  DecisionModelResponseError,
  type DecisionModelResult,
} from "../src/models"
import { validateDecisionAnswers } from "../src/models/decision/validation"
import { validateSchemaOrRefValue } from "../src/ontology/refs"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const questions = {
  category: question.choice({
    instructions: "Category?",
    options: { repair: "Repair", other: "Other" },
  }),
  severity: question.score({ instructions: "Impact?", levels: ["None", "Degraded", "Stopped"] }),
  blocked: question.probability("Blocked?"),
}
const output = {
  category: {
    choice: "repair" as const,
    probabilities: { repair: 0.8, other: 0.2 },
    confidence: 0.5,
  },
  severity: { score: 1.5, probabilities: [0, 0.5, 0.5] },
  blocked: { probability: 0.7 },
}

function modelWith(
  evaluate: DecisionModel["evaluate"] = async () => ({
    output,
    usage: { inputTokens: 10, outputTokens: 8 },
    responseModelId: "decision-v1",
  })
): DecisionModel {
  return {
    providerId: "test",
    modelId: "decision",
    definition: {
      kind: "decision",
      providerId: "test",
      modelId: "decision",
      capabilities: { questions: ["choice", "score", "probability"] },
    },
    evaluate,
  }
}
function setup(model = modelWith()) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "decisions",
    ontology: [],
    ...deps,
    models: { decision: [model] },
  })
  const controller = new AbortController()
  const sixb = bindRequestExecution(host, {
    request: new Request("http://localhost/decision", { signal: controller.signal }),
    authorization: { type: "disabled" },
  })
  const identity = { projectId: host.id, executionId: sixb.execution.id }
  return { ...deps, host, sixb, identity, controller }
}

describe("decision evaluation", () => {
  // Removal proof: skip onModelCallEnd in decision/runtime.ts; this usage assertion fails.
  test("supports decision-only projects and accounts for outputs before returning", async () => {
    const { sixb, storage, identity } = setup()
    const result = await sixb.models.decision.evaluate({ input: "A leaking unit", questions })
    expect(result.output).toEqual(output)
    expect(result.output).not.toBe(output)
    expect(result.responseModelId).toBe("decision-v1")
    expect(result.cost.status).toBe("unpriceable")
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      callId: result.callId,
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    })
    await expect(sixb.models.language.generate({ prompt: "Hi" })).rejects.toThrow("models.language")
  })

  test("selects the configured binding, never an impostor with the same identity", async () => {
    const { sixb } = setup()
    const impostor = modelWith(async () => {
      throw new Error("impostor")
    })
    expect(
      (await sixb.models.decision.evaluate({ input: "", questions, model: impostor })).output
    ).toEqual(output)
    const unknown = { ...impostor, modelId: "unknown" }
    await expect(
      sixb.models.decision.evaluate({ input: "", questions, model: unknown })
    ).rejects.toThrow("not configured")
    expect(() => createModelCatalog({ decision: [impostor, impostor] })).toThrow("Duplicate")
    expect(() => createModelCatalog({ decision: [] })).toThrow("nonempty")
  })

  test("rejects invalid questions and unsupported primitives before inference", async () => {
    let calls = 0
    const model = modelWith(async () => {
      calls++
      return { output }
    })
    const { sixb } = setup(model)
    await expect(sixb.models.decision.evaluate({ input: "x", questions: {} })).rejects.toThrow(
      "empty"
    )
    await expect(
      sixb.models.decision.evaluate({
        input: "x",
        questions: { q: { type: "score", instructions: "x", levels: ["one"] } },
      })
    ).rejects.toThrow("two")
    const limited = {
      ...model,
      definition: { ...model.definition, capabilities: { questions: ["probability" as const] } },
    }
    await expect(
      setup(limited).sixb.models.decision.evaluate({ input: "x", questions })
    ).rejects.toThrow("does not support")
    expect(calls).toBe(0)
  })

  // Removal proof: validate against input.questions instead of the snapshot; mutation breaks completion.
  test("snapshots nested input and questions before yielding", async () => {
    let seen: DecisionModelRequest | undefined
    const model = modelWith(async (request) => {
      seen = request
      return { output: { answer: { choice: "yes", probabilities: { yes: 1 } } } }
    })
    const q = {
      answer: {
        type: "choice" as const,
        instructions: "q",
        options: { yes: "Yes" } as Record<string, string>,
      },
    }
    const input = { text: "original" }
    const pending = setup(model).sixb.models.decision.evaluate({ input, questions: q })
    input.text = "changed"
    delete q.answer.options.yes
    q.answer.options.no = "No"
    q.answer.instructions = "changed"
    const result = await pending
    expect(seen?.input).toEqual({ text: "original" })
    expect(seen?.questions.answer?.instructions).toBe("q")
    expect(result.output.answer.choice).toBe("yes")
  })

  test("retains known usage for invalid results and response errors", async () => {
    for (const errorMode of [false, true]) {
      const metadata = { usage: { inputTokens: 12, outputTokens: 5 } }
      const model = modelWith(async () => {
        if (errorMode)
          throw new DecisionModelResponseError("bad response", "test", "decision", metadata)
        return { ...metadata, output: { ...output, blocked: { probability: 9 } } }
      })
      const { sixb, storage, identity } = setup(model)
      await expect(sixb.models.decision.evaluate({ input: "x", questions })).rejects.toBeInstanceOf(
        DecisionModelResponseError
      )
      expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
        usage: { totalTokens: 17 },
      })
    }
  })

  test("does not retry ambiguous transport failures or invent zero usage", async () => {
    let calls = 0
    const { sixb, storage, identity } = setup(
      modelWith(async () => {
        calls++
        throw new Error("connection lost")
      })
    )
    await expect(sixb.models.decision.evaluate({ input: "x", questions })).rejects.toThrow(
      "connection lost"
    )
    expect(calls).toBe(1)
    const recorded = await storage.aiUsage.getLatestForExecution(identity)
    expect(recorded).not.toBeNull()
    expect(recorded?.usage.totalTokens).toBeUndefined()
  })

  test("combines caller and execution cancellation and records late billable replies", async () => {
    let complete!: (result: DecisionModelResult) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let requestSignal: AbortSignal | undefined
    const model = modelWith((request) => {
      requestSignal = request.signal
      entered()
      return new Promise((resolve) => {
        complete = resolve
      })
    })
    const { sixb, controller, storage, identity } = setup(model)
    const pending = sixb.models.decision.evaluate({
      input: "x",
      questions,
      signal: new AbortController().signal,
    })
    const rejected = pending.catch((error: unknown) => error)
    await started
    controller.abort(new Error("stopped"))
    expect(requestSignal?.aborted).toBe(true)
    complete({ output, usage: { inputTokens: 3, outputTokens: 2 } })
    expect(await rejected).toMatchObject({ message: "stopped" })
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      usage: { totalTokens: 5 },
    })
  })
})

test("resolution cannot change the configured decision identity or bypass capabilities", async () => {
  // Removal proof: remove the identity/capability checks after resolve in decision/runtime.ts.
  let calls = 0
  const base = modelWith(async () => {
    calls++
    return { output }
  })
  for (const change of [{ providerId: "other" }, { modelId: "other" }]) {
    const resolved = { ...base, ...change, definition: { ...base.definition, ...change } }
    const { sixb, storage, identity } = setup({ ...base, resolve: async () => resolved })
    await expect(sixb.models.decision.evaluate({ input: "x", questions })).rejects.toThrow(
      "identity does not match"
    )
    expect(await storage.aiUsage.getLatestForExecution(identity)).toBeNull()
  }
  const resolved: DecisionModel = {
    ...base,
    definition: { ...base.definition, capabilities: { questions: ["probability"] } },
  }
  await expect(
    setup({ ...base, resolve: async () => resolved }).sixb.models.decision.evaluate({
      input: "x",
      questions,
    })
  ).rejects.toThrow("does not support")
  expect(calls).toBe(0)
})

test("cancellation during resolution prevents decision admission and inference", async () => {
  let calls = 0
  const base = modelWith(async () => {
    calls++
    return { output }
  })
  const controller = new AbortController()
  const { sixb, storage, identity } = setup({
    ...base,
    resolve: async () => {
      controller.abort(new Error("cancelled while resolving"))
      return base
    },
  })
  await expect(
    sixb.models.decision.evaluate({ input: "x", questions, signal: controller.signal })
  ).rejects.toThrow("cancelled while resolving")
  expect(calls).toBe(0)
  expect(await storage.aiUsage.getLatestForExecution(identity)).toBeNull()
})

test("answer precision permits bounded rounding without normalizing or weakening default validation", () => {
  const rounded = { ...output, severity: { score: 0.73, probabilities: [0.28, 0.72, 0] } }
  expect(() => validateDecisionAnswers(questions, rounded)).toThrow("inconsistent")
  expect(validateDecisionAnswers(questions, rounded, 2)).toEqual(rounded)
  const thirds = { ...output, severity: { score: 1, probabilities: [0.33, 0.33, 0.33] } }
  expect(validateDecisionAnswers(questions, thirds, 2)).toEqual(thirds)
  for (const severity of [
    { score: 0.9, probabilities: [0.28, 0.72, 0] },
    { score: 1, probabilities: [0.3, 0.3, 0.3] },
    { score: -0.01, probabilities: [1, 0, 0] },
    { score: 2.01, probabilities: [0, 0, 1] },
    { score: 1, probabilities: [-0.01, 1.01, 0] },
  ]) {
    expect(() => validateDecisionAnswers(questions, { ...output, severity }, 2)).toThrow()
  }
  const base = modelWith()
  for (const answerDecimalPlaces of [0, -1, 1.5, 16, Number.NaN]) {
    expect(() =>
      createModelCatalog({
        decision: [
          {
            ...base,
            definition: {
              ...base.definition,
              capabilities: { ...base.definition.capabilities, answerDecimalPlaces },
            },
          },
        ],
      })
    ).toThrow("answerDecimalPlaces")
  }
})

test("rounded scores must be feasible with a normalized underlying distribution", () => {
  // Removal proof: restore the independent-error tolerance in validateScoreAnswer;
  // scores 0.2 and 8.8 below are then incorrectly accepted for ten-level scales.
  const questions = {
    rating: question.score({
      instructions: "Rate the impact",
      levels: ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
    }),
  }
  for (const probabilities of [
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  ]) {
    const lowEnd = probabilities[0] === 1
    // At most 0.005 mass can leave the endpoint, moving the mean by at most 9 * 0.005.
    // The separately rounded score adds another 0.005; inclusive ties tolerate either rule.
    for (const score of lowEnd ? [0, 0.04, 0.05] : [8.95, 8.96, 9]) {
      const output = { rating: { score, probabilities } }
      expect(validateDecisionAnswers(questions, output, 2)).toEqual(output)
    }
    for (const score of lowEnd ? [0.06, 0.2] : [8.8, 8.94]) {
      expect(() =>
        validateDecisionAnswers(questions, { rating: { score, probabilities } }, 2)
      ).toThrow("inconsistent")
    }
  }
})

test("output schemas preserve ordinary workflow validation", () => {
  const schemas = decisionOutput(questions)
  for (const [key, schema] of Object.entries(schemas)) {
    validateSchemaOrRefValue(schema, output[key as keyof typeof output], key, new Map())
  }
  expect(() =>
    validateSchemaOrRefValue(
      schemas.category,
      { ...output.category, choice: "unknown" },
      "category",
      new Map()
    )
  ).toThrow()
})

test.each([
  { ...output, blocked: { probability: Number.NaN } },
  { ...output, blocked: { probability: -1 } },
  { ...output, blocked: { probability: 0.5, confidence: 0.9 } },
  { ...output, category: { choice: "other", probabilities: { repair: 0.8, other: 0.2 } } },
  { ...output, category: { choice: "repair", probabilities: { repair: 0.4, other: 0.4 } } },
  { ...output, category: { choice: "repair", probabilities: { repair: 1, extra: 0 } } },
  { ...output, severity: { score: 1, probabilities: [1, 0, 0] } },
  { ...output, severity: { score: 0, probabilities: [1] } },
  { ...output, extra: { probability: 1 } },
])("rejects malformed distributions and mismatched answers %#", (value) => {
  expect(() => validateDecisionAnswers(questions, value)).toThrow()
})

test("question descriptors handle reserved object keys without prototype mutation", () => {
  const options = JSON.parse('{"__proto__":"Prototype","constructor":"Constructor"}') as Record<
    string,
    string
  >
  const q = { pick: question.choice({ instructions: "pick", options }) }
  const result = validateDecisionAnswers(
    q,
    JSON.parse('{"pick":{"choice":"__proto__","probabilities":{"__proto__":1,"constructor":0}}}')
  )
  expect(Object.hasOwn(result.pick.probabilities, "__proto__")).toBe(true)
  expect(
    Object.hasOwn(decisionOutput(q).pick.properties.probabilities.schema.properties, "__proto__")
  ).toBe(true)
})

test("decision admission denies over-budget calls before contacting the provider", async () => {
  // Removal proof: remove accounting.admitCall in decision/runtime.ts; the provider is reached.
  let calls = 0
  const { sixb, storage, host } = setup(
    modelWith(async () => {
      calls++
      return { output }
    })
  )
  await storage.aiLimits.createPolicy({
    id: "tokens",
    projectId: host.id,
    subject: { type: "project" },
    limit: { meter: "tokens.total", amount: 1 },
  })
  await expect(sixb.models.decision.evaluate({ input: "x", questions })).rejects.toMatchObject({
    code: "ai.usage_limit_exceeded",
  })
  expect(calls).toBe(0)
})

test("concurrent decisions retain separate accounting identities", async () => {
  const { sixb, storage, identity } = setup()
  const results = await Promise.all(
    [0, 1].map(() => sixb.models.decision.evaluate({ input: "x", questions }))
  )
  expect(new Set(results.map((result) => result.callId)).size).toBe(2)
  expect(await storage.aiUsage.summarizeExecution(identity)).toMatchObject({ modelCallCount: 2 })
})

test("a choice-only provider needs neither TypeSafe nor accounting metadata", async () => {
  const base = modelWith(async () => ({
    output: { category: { choice: "repair", probabilities: { repair: 0.75, other: 0.25 } } },
  }))
  const model: DecisionModel = {
    ...base,
    definition: {
      ...base.definition,
      capabilities: { questions: ["choice"], maxChoices: 2 },
    },
  }
  const { sixb } = setup(model)
  const result = await sixb.models.decision.evaluate({
    input: "Repair needed",
    questions: { category: questions.category },
  })
  expect(result.output.category).toEqual({
    choice: "repair",
    probabilities: { repair: 0.75, other: 0.25 },
  })
  expect(result.usage).toEqual({})
  expect(result.cost.status).toBe("unpriceable")

  await expect(sixb.models.decision.evaluate({ input: "x", questions })).rejects.toThrow(
    "does not support"
  )
  await expect(
    sixb.models.decision.evaluate({
      input: "x",
      questions: {
        category: question.choice({
          instructions: "Category?",
          options: { repair: "Repair", other: "Other", billing: "Billing" },
        }),
      },
    })
  ).rejects.toThrow("does not support")
})

test("decision catalogs preserve ordering, safe identities and family-specific empty rules", () => {
  const binding = (providerId: string, modelId: string): DecisionModel => {
    const base = modelWith()
    return { ...base, providerId, modelId, definition: { ...base.definition, providerId, modelId } }
  }
  const first = binding("a/b", "c")
  const second = binding("a", "b/c")
  const catalog = createModelCatalog({ decision: [first, second], embedding: [] })

  expect(catalog.decision.default.model).toBe(first)
  expect(catalog.decision.list().map((entry) => entry.model)).toEqual([first, second])
  expect(catalog.decision.getByRef({ provider: "a/b", modelId: "c" })?.model).toBe(first)
  expect(catalog.decision.getByRef({ provider: "a", modelId: "b/c" })?.model).toBe(second)
  expect(catalog.decision.getByRef({ provider: "missing", modelId: "c" })).toBeNull()
  expect(Object.isFrozen(catalog.decision.list())).toBe(true)
  expect(Object.isFrozen(first)).toBe(false)
  expect(catalog.language).toBeUndefined()
  expect(catalog.embedding.list()).toEqual([])
  expect(() => createModelCatalog({ embedding: [] })).toThrow("at least one")
  expect(() => createModelCatalog({ decision: [], embedding: [] })).toThrow("nonempty")
})
