import { expect, test } from "bun:test"
import { createVercelGateway } from "../src"

test("embedding uses configured transport and restores input order", async () => {
  const gateway = createVercelGateway({
    apiKey: () => "test-key",
    baseUrl: "https://gateway.test/v1",
    fetch: async (url, init) => {
      expect(url).toBe("https://gateway.test/v1/embeddings")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key")
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "openai/test",
        input: ["first", "second"],
        dimensions: 2,
        encoding_format: "float",
      })
      return Response.json({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      })
    },
  })
  const model = gateway.embedding("openai/test", { dimensions: 2 })
  expect(model.definition).toEqual({
    kind: "embedding",
    providerId: "vercel-ai-gateway",
    modelId: "openai/test",
    dimensions: 2,
    representation: { name: "openai/test" },
  })
  expect((await model.embed({ texts: ["first", "second"] })).vectors).toEqual([
    [1, 0],
    [0, 1],
  ])
})

test("embedding rejects malformed provider responses before returning vectors", async () => {
  // Regression proof: remove the per-entry validation in embedding.ts; malformed cases must fail.
  for (const data of [
    [],
    [{ index: 0, embedding: [1] }],
    [{ index: 0, embedding: [0, 0] }],
    [{ index: 0, embedding: [1e40, 1] }],
    [{ index: 2, embedding: [1, 0] }],
    [
      { index: 0, embedding: [1, 0] },
      { index: 0, embedding: [0, 1] },
    ],
  ]) {
    const model = createVercelGateway({ fetch: async () => Response.json({ data }) }).embedding(
      "openai/test",
      { dimensions: 2 }
    )
    await expect(
      model.embed({ texts: data.length === 2 ? ["one", "two"] : ["one"] })
    ).rejects.toThrow("Invalid embedding response")
  }
})

test("embedding validates inputs and supports cancellation without implicit retries", async () => {
  let calls = 0
  const controller = new AbortController()
  const model = createVercelGateway({
    fetch: async (_url, init) => {
      calls++
      expect(init?.signal).toBe(controller.signal)
      return Response.json({ error: { message: "Unavailable" } }, { status: 503 })
    },
  }).embedding("openai/test", { dimensions: 2 })
  expect(await model.embed({ texts: [] })).toEqual({ vectors: [] })
  await expect(model.embed({ texts: [""] })).rejects.toThrow()
  expect(calls).toBe(0)
  await expect(model.embed({ texts: ["hello"], signal: controller.signal })).rejects.toMatchObject({
    status: 503,
  })
  expect(calls).toBe(1)
  controller.abort()
  await expect(model.embed({ texts: ["hello"], signal: controller.signal })).rejects.toThrow()
  expect(calls).toBe(1)
  expect(() => createVercelGateway().embedding("openai/test", { dimensions: 0 })).toThrow()
})

test("embedding preserves usage, provider identifiers and reported cost on invalid vectors", async () => {
  const model = createVercelGateway({
    fetch: async () =>
      Response.json(
        {
          model: "test/actual",
          data: [{ index: 0, embedding: [0, 0] }],
          usage: { prompt_tokens: 6, total_tokens: 6 },
          providerMetadata: { gateway: { cost: "0.00000012", generationId: "gen_abc" } },
        },
        { headers: { "x-request-id": "request-123" } }
      ),
  }).embedding("openai/test", { dimensions: 2 })
  await expect(model.embed({ texts: ["text"] })).rejects.toMatchObject({
    code: "invalid_embedding_response",
    retryable: false,
    metadata: {
      usage: { inputTokens: 6, outputTokens: 0, raw: { prompt_tokens: 6, total_tokens: 6 } },
      providerIds: { requestId: "request-123", generationId: "gen_abc" },
      responseModelId: "test/actual",
      reportedCost: { money: { currency: "USD", amountNanos: "120" } },
    },
  })
})

test("embedding pins input pricing without requiring a language model or output tariff", async () => {
  let calls = 0
  const gateway = createVercelGateway({
    fetch: async () => {
      calls += 1
      return Response.json({
        data: [{ id: "openai/test", type: "embedding", pricing: { input: "0.000001" } }],
      })
    },
  })
  const resolved = await gateway.embedding("openai/test", { dimensions: 2 }).resolve!()
  expect(calls).toBe(1)
  expect(
    resolved.costEstimator?.estimateReservation?.({ inputTokens: 10, outputTokens: 0 })
  ).toEqual({
    currency: "USD",
    amountNanos: "10000",
  })
  expect(
    resolved.costEstimator?.estimate({ usage: { inputTokens: 6, outputTokens: 0 } })
  ).toMatchObject({
    status: "rated",
    money: { amountNanos: "6000" },
  })
  expect(resolved.costEstimator?.estimate({ usage: { outputTokens: 0 } })).toMatchObject({
    status: "unpriceable",
  })
})

test("embedding resolution preserves captured dimensions when caller options change", async () => {
  // Removal proof: pass the original options object to createGatewayEmbedding in resolve().
  const options = { dimensions: 2 }
  const gateway = createVercelGateway({ fetch: async () => Response.json({ data: [] }) })
  const binding = gateway.embedding("test/model", options)
  options.dimensions = 3
  const model = await binding.resolve!()
  expect(model.definition.dimensions).toBe(2)
})
