import { expect, test } from "bun:test"
import { question } from "@sixb/core"
import { createVercelGateway } from "../src"
import {
  decisionCatalog,
  decisionPayload,
  decisionQuestions,
  decisionRuntime,
} from "./decision-fixture"

test("decision translates all primitives and reuses the configured Gateway transport", async () => {
  let calls = 0
  let key = "first"
  const options = { providerOptions: { gateway: { only: ["typesafe-ai"] } } }
  const model = createVercelGateway({
    baseUrl: "https://gateway.test/v1/",
    apiKey: () => key,
    headers: () => ({ "x-custom": key }),
    fetch: async (url, init) => {
      calls++
      expect(url).toBe("https://gateway.test/v1/evaluate")
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${key}`)
      expect(new Headers(init?.headers).get("x-custom")).toBe(key)
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "typesafe-ai/jev",
        state: { text: "Refund please" },
        questions: {
          category: {
            type: "choice",
            instructions: decisionQuestions.category.instructions,
            criteria: decisionQuestions.category.options,
          },
          impact: {
            type: "score",
            instructions: decisionQuestions.impact.instructions,
            criteria: decisionQuestions.impact.levels,
          },
          refund: { type: "boolean", instructions: decisionQuestions.refund.instructions },
        },
        providerOptions: { gateway: { only: ["typesafe-ai"] } },
      })
      return Response.json(decisionPayload, { headers: { "x-request-id": "req-test" } })
    },
  }).decision("typesafe-ai/jev", options)
  expect(calls).toBe(0)
  options.providerOptions.gateway.only[0] = "changed"
  for (key of ["first", "rotated"]) {
    const result = await model.evaluate({
      input: { text: "Refund please" },
      questions: decisionQuestions,
    })
    expect(result.output).toEqual({
      category: { choice: "billing", probabilities: { billing: 0.8, technical: 0.2 } },
      impact: { score: 1.5, probabilities: [0, 0.5, 0.5], confidence: 0.5 },
      refund: { probability: 0.9 },
    })
    expect(result).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 25 },
      providerIds: { requestId: "req-test", generationId: "gen_test123" },
      reportedCost: { money: { currency: "USD", amountNanos: "4200" } },
      route: { providerId: "typesafe-ai" },
      responseModelId: "typesafe-ai/jev",
    })
  }
  expect(calls).toBe(2)
})

test("malformed answers preserve billing metadata", async () => {
  // Removal proof: omit metadata from DecisionModelResponseError in decision.ts.
  for (const answers of [
    {},
    { ...decisionPayload.answers, extra: {} },
    { ...decisionPayload.answers, refund: { type: "noul", noul: 0.9 } },
    {
      ...decisionPayload.answers,
      impact: { type: "score", score: 1, probabilities: { "0": 0, "1": 1 } },
    },
    {
      ...decisionPayload.answers,
      category: {
        type: "choice",
        choice: "billing",
        probabilities: { billing: "1", technical: 0 },
      },
    },
  ]) {
    const model = createVercelGateway({
      fetch: async () => Response.json({ ...decisionPayload, answers }),
    }).decision("typesafe-ai/jev")
    await expect(
      model.evaluate({ input: "x", questions: decisionQuestions })
    ).rejects.toMatchObject({
      code: "invalid_decision_response",
      metadata: {
        usage: { inputTokens: 100, outputTokens: 25 },
        reportedCost: { money: { amountNanos: "4200" } },
        providerIds: { generationId: "gen_test123" },
      },
    })
  }
})

test("unknown counters remain unknown and prototype-like question names remain data", async () => {
  const questions = Object.fromEntries(
    ["__proto__", "constructor"].map((key) => [key, question.probability("Refund?")])
  )
  const model = createVercelGateway({
    fetch: async (_url, init) => {
      expect(Object.keys(JSON.parse(String(init?.body)).questions)).toEqual([
        "__proto__",
        "constructor",
      ])
      return Response.json({
        model: "typesafe-ai/jev",
        usage: { inputTokens: -1, outputTokens: 2 },
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: "boolean", probability: 0.5 }])
        ),
      })
    },
  }).decision("typesafe-ai/jev")
  const result = await model.evaluate({ input: ["structured", { text: "state" }], questions })
  expect(Object.keys(result.output)).toEqual(["__proto__", "constructor"])
  expect(result.usage?.inputTokens).toBeUndefined()
  expect(result.usage?.outputTokens).toBe(2)
})

test("HTTP failures have safe metadata and never retry", async () => {
  let calls = 0
  const model = createVercelGateway({
    maxRetries: 5,
    fetch: async () => {
      calls++
      return Response.json(
        { error: { message: "private state" } },
        {
          status: 429,
          headers: { "retry-after": "2", "x-request-id": "req-rejected" },
        }
      )
    },
  }).decision("typesafe-ai/jev")
  await expect(model.evaluate({ input: "x", questions: decisionQuestions })).rejects.toMatchObject({
    status: 429,
    retryable: true,
    retryAfterMs: 2000,
    requestId: "req-rejected",
    message: "[SixbVercelGateway] Evaluation returned HTTP 429.",
  })
  expect(calls).toBe(1)
  const invalid = createVercelGateway({ fetch: async () => new Response("bad JSON") }).decision(
    "typesafe-ai/jev"
  )
  await expect(
    invalid.evaluate({ input: "x", questions: decisionQuestions })
  ).rejects.toMatchObject({ code: "invalid_json" })
})

test("decision validates construction and propagates cancellation and timeouts", async () => {
  for (const id of ["", " x "]) expect(() => createVercelGateway().decision(id)).toThrow()
  for (const timeoutMs of [0, -1, 1.5, Infinity]) {
    expect(() => createVercelGateway().decision("typesafe-ai/jev", { timeoutMs })).toThrow()
  }
  let calls = 0
  const controller = new AbortController()
  const model = createVercelGateway({
    fetch: async (_url, init) => {
      calls++
      const signal = init!.signal!
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        if (calls === 1) controller.abort(new Error("cancelled"))
      })
    },
  }).decision("typesafe-ai/jev", { timeoutMs: 20 })
  await expect(
    model.evaluate({ input: "x", questions: decisionQuestions, signal: controller.signal })
  ).rejects.toThrow("cancelled")
  await expect(
    model.evaluate({ input: "x", questions: decisionQuestions, signal: controller.signal })
  ).rejects.toThrow("cancelled")
  expect(calls).toBe(1)
  await expect(model.evaluate({ input: "x", questions: decisionQuestions })).rejects.toMatchObject({
    name: "TimeoutError",
  })
  expect(calls).toBe(2)
})

test("pricing is pinned per resolved decision and evaluation entries stay out of the language catalog", async () => {
  let price = "0.000000042"
  const gateway = createVercelGateway({ fetch: async () => Response.json(decisionCatalog(price)) })
  const binding = gateway.decision("typesafe-ai/jev")
  const first = await binding.resolve!()
  expect(first.definition.name).toBe("Jev")
  expect(first.definition.kind).toBe("decision")
  expect(await gateway.catalog.list()).toEqual([])
  price = "0.000001"
  await gateway.catalog.refresh()
  const second = await binding.resolve!()
  const tokens = { inputTokens: 100, outputTokens: 25 }
  expect(first.costEstimator?.estimateReservation?.(tokens)?.amountNanos).toBe("4200")
  expect(second.costEstimator?.estimateReservation?.(tokens)?.amountNanos).toBe("100000")
  expect(
    first.costEstimator?.estimate({ usage: tokens, responseModelId: "other/model" }).status
  ).toBe("unpriceable")
  const routed = await gateway.decision("typesafe-ai/jev", {
    providerOptions: { gateway: { models: ["other/model"] } },
  }).resolve!()
  expect(routed.costEstimator?.estimateReservation?.(tokens)).toBeUndefined()
})

test("runtime resolves pricing before admission and persists Gateway accounting", async () => {
  // Removal proof: replace binding.resolve() with binding in core decision/runtime.ts.
  const calls: string[] = []
  const model = createVercelGateway({
    fetch: async (url) => {
      calls.push(String(url))
      return Response.json(String(url).endsWith("/models") ? decisionCatalog() : decisionPayload)
    },
  }).decision("typesafe-ai/jev")
  const { sixb, host, storage, identity } = decisionRuntime(model)
  await storage.aiLimits.createPolicy({
    id: "budget",
    projectId: host.id,
    subject: { type: "project" },
    limit: {
      meter: "cost.catalogEstimated",
      amount: { currency: "USD", amountNanos: "1000000000" },
    },
  })
  const result = await sixb.models.decision.evaluate({
    input: "Refund please",
    questions: decisionQuestions,
  })
  expect(calls.map((url) => new URL(url).pathname)).toEqual(["/v1/models", "/v1/evaluate"])
  expect(result.cost).toMatchObject({ status: "reported", money: { amountNanos: "4200" } })
  expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
    callId: result.callId,
    providerId: "vercel-ai-gateway",
    requestedModelId: "typesafe-ai/jev",
    usage: { totalTokens: 125 },
  })
})

test("unavailable catalog pricing fails closed under a cost limit without inference", async () => {
  let calls = 0
  const { sixb, host, storage } = decisionRuntime(
    createVercelGateway({
      fetch: async (url) => {
        calls++
        expect(String(url)).toEndWith("/models")
        return Response.json({ data: [] })
      },
    }).decision("typesafe-ai/jev")
  )
  await storage.aiLimits.createPolicy({
    id: "budget",
    projectId: host.id,
    subject: { type: "project" },
    limit: {
      meter: "cost.catalogEstimated",
      amount: { currency: "USD", amountNanos: "1000000000" },
    },
  })
  await expect(
    sixb.models.decision.evaluate({ input: "x", questions: decisionQuestions })
  ).rejects.toMatchObject({ code: "ai.usage_limit_unavailable" })
  expect(calls).toBe(1)
})

test("live Jev rounding is preserved while inconsistent answers still fail with accounting", async () => {
  // Observed 2026-09-23 via /v1/evaluate: score 0.73, probabilities [0.28, 0.72, 0].
  // Removal proof: remove answerDecimalPlaces from gatewayDecisionDefinition; the first call fails.
  for (const score of [0.73, 0.9]) {
    const payload = structuredClone(decisionPayload)
    payload.answers.impact = {
      type: "score",
      score,
      probabilities: { "0": 0.28, "1": 0.72, "2": 0 },
      confidence: 0.59,
    }
    const { sixb, storage, identity } = decisionRuntime(
      createVercelGateway({
        fetch: async (url) =>
          Response.json(String(url).endsWith("/models") ? decisionCatalog() : payload),
      }).decision("typesafe-ai/jev")
    )
    const result = sixb.models.decision.evaluate({
      input: "Refund please",
      questions: decisionQuestions,
    })
    if (score === 0.73) {
      expect((await result).output.impact).toEqual({
        score: 0.73,
        probabilities: [0.28, 0.72, 0],
        confidence: 0.59,
      })
    } else {
      await expect(result).rejects.toMatchObject({ code: "invalid_decision_response" })
    }
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      usage: { totalTokens: 125 },
    })
  }
})
