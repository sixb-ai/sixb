import { expect, test } from "bun:test"
import { createVercelGateway } from "../src"

test("reranking uses the configured gateway with its versioned protocol and billing metadata", async () => {
  const controller = new AbortController()
  const model = createVercelGateway({
    baseUrl: "https://gateway.test/proxy/v1",
    apiKey: () => "test-key",
    fetch: async (url, init) => {
      expect(url).toBe("https://gateway.test/proxy/v4/ai/reranking-model")
      expect(init?.signal).toBe(controller.signal)
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer test-key")
      expect(headers.get("ai-model-id")).toBe("voyage/rerank-2.5-lite")
      expect(headers.get("ai-reranking-model-specification-version")).toBe("4")
      expect(JSON.parse(String(init?.body))).toEqual({
        query: "find",
        documents: { type: "text", values: ["first", "second"] },
        topN: 2,
      })
      return Response.json(
        {
          ranking: [
            { index: 1, relevanceScore: 0.8 },
            { index: 0, relevanceScore: 0.2 },
          ],
          providerMetadata: {
            gateway: {
              cost: "0.0000015",
              generationId: "gen_123",
              routing: { finalProvider: "voyage" },
            },
          },
        },
        { headers: { "x-request-id": "request-1" } }
      )
    },
  }).reranking("voyage/rerank-2.5-lite")
  const result = await model.rerank({
    query: "find",
    documents: ["first", "second"],
    signal: controller.signal,
  })
  expect(result).toMatchObject({
    results: [
      { index: 1, score: 0.8 },
      { index: 0, score: 0.2 },
    ],
    providerIds: { requestId: "request-1", generationId: "gen_123" },
    reportedCost: { money: { currency: "USD", amountNanos: "1500" } },
    route: { providerId: "voyage" },
  })
  expect(result.usage).toBeUndefined()
})

test("malformed ranking preserves charge evidence", async () => {
  // Removal proof: remove index/completeness checks in reranking.ts; invalid payloads succeed.
  for (const ranking of [
    [],
    [{ index: 2, relevanceScore: 1 }],
    [{ index: 0, relevanceScore: "bad" }],
    [
      { index: 0, relevanceScore: 1 },
      { index: 0, relevanceScore: 1 },
    ],
  ]) {
    const model = createVercelGateway({
      fetch: async () =>
        Response.json({
          ranking,
          providerMetadata: { gateway: { cost: "0.000001" } },
        }),
    }).reranking("test/model")
    await expect(
      model.rerank({ query: "find", documents: ranking.length === 2 ? ["one", "two"] : ["one"] })
    ).rejects.toMatchObject({
      code: "invalid_reranking_response",
      retryable: false,
      metadata: { reportedCost: { money: { amountNanos: "1000" } } },
    })
  }
})

test("transport failures do not leak provider bodies or trigger implicit retries", async () => {
  let calls = 0
  const model = createVercelGateway({
    fetch: async () => {
      calls++
      return Response.json({ error: { message: "private document text" } }, { status: 503 })
    },
  }).reranking("test/model")
  await expect(model.rerank({ query: "find", documents: ["one"] })).rejects.toMatchObject({
    status: 503,
    message: "[SixbVercelGateway] Reranking returned HTTP 503.",
  })
  expect(calls).toBe(1)
  await expect(
    model.rerank({ query: "find", documents: ["one"], signal: AbortSignal.abort() })
  ).rejects.toThrow()
  expect(await model.rerank({ query: "find", documents: [] })).toEqual({ results: [] })
  await expect(model.rerank({ query: " ", documents: ["one"] })).rejects.toThrow()
  expect(calls).toBe(1)
})

test("reranking pins known input pricing and leaves unavailable tariffs unknown", async () => {
  let input = "0.00000002"
  const gateway = createVercelGateway({
    fetch: async () =>
      Response.json({
        data: [
          { id: "voyage/rerank-2.5-lite", type: "reranking", pricing: { input } },
          { id: "cohere/rerank-v4.0-pro", type: "reranking", pricing: {} },
        ],
      }),
  })
  const resolved = await gateway.reranking("voyage/rerank-2.5-lite").resolve!()
  input = "0.000004"
  await gateway.catalog.refresh()
  expect(
    resolved.costEstimator?.estimateReservation?.({ inputTokens: 100, outputTokens: 0 })
  ).toEqual({ currency: "USD", amountNanos: "2000" })
  expect(
    resolved.costEstimator?.estimate({ usage: { inputTokens: 100, outputTokens: 0 } })
  ).toMatchObject({ status: "rated", money: { amountNanos: "2000" } })
  expect(resolved.costEstimator?.estimate({ usage: { outputTokens: 0 } })).toMatchObject({
    status: "unpriceable",
  })
  const unknown = await gateway.reranking("cohere/rerank-v4.0-pro").resolve!()
  expect(
    unknown.costEstimator?.estimateReservation?.({ inputTokens: 100, outputTokens: 0 })
  ).toBeUndefined()
})
