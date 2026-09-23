import { describe, expect, test } from "bun:test"
import { question } from "@sixb/core"
import { DecisionModelResponseError, ModelProviderError } from "@sixb/core/models"
import { createTypesafe } from "../src"

const questions = {
  category: question.choice({
    instructions: "What kind?",
    options: { repair: "Repair", other: "Other" },
  }),
  impact: question.score({ instructions: "How severe?", levels: ["None", "Degraded", "Stopped"] }),
  urgent: question.probability("Urgent?"),
}
const payload = {
  model: "jev-1.13.0",
  answers: {
    category: {
      type: "choice",
      choice: "repair",
      probabilities: { repair: 0.8, other: 0.2 },
      confidence: 0.5,
    },
    impact: {
      type: "score",
      score: 1.5,
      probabilities: { "0": 0, "1": 0.5, "2": 0.5 },
      legend: { "0": "None", "1": "Degraded", "2": "Stopped" },
      confidence: 0.3,
    },
    urgent: { type: "noul", noul: 0.9 },
  },
  usage: { input_tokens: 100, output_tokens: 25 },
}
function response() {
  return Response.json(payload, { headers: { "x-request-id": "request-1" } })
}

describe("TypeSafe provider", () => {
  test("translates all three primitives in one request and preserves metadata", async () => {
    let sent: unknown
    const jev = createTypesafe({
      apiKey: "secret",
      fetch: async (url, init) => {
        expect(url).toBe("https://api.typesafe.ai/v1/systemone")
        expect(init?.headers).toMatchObject({ authorization: "Bearer secret" })
        sent = JSON.parse(String(init?.body))
        return response()
      },
    })("jev-1.13.0")
    const result = await jev.evaluate({ input: { description: "Broken pump" }, questions })
    expect(sent).toMatchObject({
      model: "jev-1.13.0",
      state: { description: "Broken pump" },
      questions: {
        category: { type: "choice", criteria: { repair: "Repair", other: "Other" } },
        impact: { type: "score", criteria: ["None", "Degraded", "Stopped"] },
        urgent: { type: "noul" },
      },
    })
    expect(result).toMatchObject({
      output: {
        category: { choice: "repair" },
        impact: { score: 1.5, probabilities: [0, 0.5, 0.5] },
        urgent: { probability: 0.9 },
      },
      usage: { inputTokens: 100, outputTokens: 25 },
      responseModelId: "jev-1.13.0",
      providerIds: { requestId: "request-1" },
    })
    expect(
      jev.costEstimator?.estimate({ usage: result.usage!, responseModelId: result.responseModelId })
    ).toMatchObject({
      status: "rated",
      money: { currency: "USD", amountNanos: "4200" },
    })
  })

  test("does not extrapolate prices to unknown models, aliases before admission or custom endpoints", () => {
    const alias = createTypesafe()("jev-latest")
    expect(
      alias.costEstimator?.estimateReservation?.({ inputTokens: 10, outputTokens: 20 })
    ).toBeUndefined()
    expect(
      alias.costEstimator?.estimate({
        usage: { inputTokens: 10, outputTokens: 20 },
        responseModelId: "jev-1.13.0",
      }).status
    ).toBe("rated")
    expect(
      alias.costEstimator?.estimate({
        usage: { inputTokens: 10, outputTokens: 20 },
        responseModelId: "jev-2.0.0",
      }).status
    ).toBe("unpriceable")
    const custom = createTypesafe({ baseUrl: "https://example.test/v1" })("jev-1.13.0")
    expect(
      custom.costEstimator?.estimate({ usage: { inputTokens: 10, outputTokens: 20 } }).status
    ).toBe("unpriceable")
  })

  test.each([
    401, 422, 429, 529, 503,
  ])("surfaces HTTP %i without hidden retries or upstream content", async (status) => {
    let calls = 0
    const model = createTypesafe({
      apiKey: "secret",
      fetch: async () => {
        calls++
        return new Response("sensitive input and credentials", {
          status,
          headers: { "retry-after": "2" },
        })
      },
    })("jev-1.13.0")
    const error = await model.evaluate({ input: "", questions }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelProviderError)
    expect(error).toMatchObject({ status, retryAfterMs: 2000 })
    expect(String(error)).not.toContain("sensitive")
    expect(calls).toBe(1)
  })

  test("cancellation reaches transport and missing keys fail without a request", async () => {
    const controller = new AbortController()
    let calls = 0
    const model = createTypesafe({
      apiKey: "secret",
      fetch: async (_, init) => {
        calls++
        expect(init?.signal).toBeDefined()
        controller.abort(new Error("cancelled"))
        init?.signal?.throwIfAborted()
        return response()
      },
    })("jev-1.13.0")
    await expect(
      model.evaluate({ input: "", questions, signal: controller.signal })
    ).rejects.toThrow("cancelled")
    expect(calls).toBe(1)
    const missing = createTypesafe({
      apiKey: "",
      fetch: async () => {
        throw new Error("unexpected HTTP")
      },
    })("jev-1.13.0")
    await expect(missing.evaluate({ input: "", questions })).rejects.toThrow("TYPESAFE_API_KEY")
  })

  test("preserves billable metadata when wire answer shape is invalid", async () => {
    const model = createTypesafe({
      apiKey: "secret",
      fetch: async () =>
        Response.json({
          ...payload,
          answers: {
            ...payload.answers,
            impact: { ...payload.answers.impact, probabilities: { "0": 1 } },
          },
        }),
    })("jev-1.13.0")
    const error = await model.evaluate({ input: "", questions }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DecisionModelResponseError)
    expect(error).toMatchObject({ metadata: { usage: { inputTokens: 100, outputTokens: 25 } } })
  })
})

test("a pinned version cannot silently return another Jev model", async () => {
  // Removal proof: remove the pinned-model comparison in response.ts.
  const model = createTypesafe({
    apiKey: "secret",
    fetch: async () => Response.json({ ...payload, model: "jev-2.0.0" }),
  })("jev-1.13.0")
  const error = await model.evaluate({ input: "", questions }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(DecisionModelResponseError)
  expect(error).toMatchObject({
    metadata: { responseModelId: "jev-2.0.0", usage: { inputTokens: 100, outputTokens: 25 } },
  })
})

test("invalid JSON is a provider error and absent usage stays unknown", async () => {
  const invalid = createTypesafe({ apiKey: "secret", fetch: async () => new Response("{") })(
    "jev-1.13.0"
  )
  await expect(invalid.evaluate({ input: "", questions })).rejects.toMatchObject({
    code: "invalid_json",
  })
  const missing = createTypesafe({
    apiKey: "secret",
    fetch: async () => Response.json({ model: payload.model, answers: payload.answers }),
  })("jev-1.13.0")
  const result = await missing.evaluate({ input: "", questions })
  expect(result.usage).toEqual({})
  expect(missing.costEstimator?.estimate({ usage: result.usage! }).status).toBe("unpriceable")
})

test("resolves credentials on each evaluation without rebuilding the provider", async () => {
  // Removal proof: capture transport.apiKey() while creating the model; the second call fails.
  let key = "first-key"
  const authorization: unknown[] = []
  const model = createTypesafe({
    apiKey: () => key,
    fetch: async (_, init) => {
      authorization.push(new Headers(init?.headers).get("authorization"))
      return response()
    },
  })("jev-1.13.0")

  await model.evaluate({ input: "x", questions })
  key = "second-key"
  await model.evaluate({ input: "x", questions })
  expect(authorization).toEqual(["Bearer first-key", "Bearer second-key"])
})
