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
  const gateway = createVercelGateway({ fetch: async () => Response.json({ data: [] }) })
  for (const modelId of ["test/model", "voyage/voyage-4-large", "cohere/embed-v4.0"]) {
    const options = { dimensions: 2 }
    const binding = gateway.embedding(modelId, options)
    options.dimensions = 3
    const model = await binding.resolve!()
    expect(model.definition.dimensions).toBe(2)
    expect(model.definition).toEqual(binding.definition)
    expect(model.batching).toEqual(binding.batching)
  }
})

test("only known embedding routes advertise safe automatic batching bounds", () => {
  // Removal proof: restore OpenAI-only bounds; Voyage/Cohere assertions fail.
  const gateway = createVercelGateway()
  for (const name of ["3-small", "3-large", "ada-002"]) {
    expect(
      gateway.embedding(`openai/text-embedding-${name}`, { dimensions: 1536 }).batching
    ).toEqual({ maxInputs: 2048, maxInputBytes: 8191, maxTotalInputBytes: 300000 })
  }
  for (const modelId of ["voyage-4", "voyage-4-lite", "voyage-4-large"]) {
    expect(gateway.embedding(`voyage/${modelId}`, { dimensions: 512 }).batching).toEqual({
      maxInputs: 1000,
      maxInputBytes: 31000,
      maxTotalInputBytes: 64000,
    })
  }
  expect(gateway.embedding("cohere/embed-v4.0", { dimensions: 512 }).batching).toEqual({
    maxInputs: 96,
    maxInputBytes: 127000,
    maxTotalInputBytes: 127000,
  })
  expect(gateway.embedding("voyage/future-model", { dimensions: 512 }).batching).toBeUndefined()
  expect(gateway.embedding("other/embedding", { dimensions: 1536 }).batching).toBeUndefined()
})

test("verified retrieval routes require a purpose and send only their supported options", async () => {
  // Removal proof: omit purpose/options handling; this admits an ambiguous call or loses inputType.
  // Restore the shared outputDimension option to reproduce the redundant Cohere override.
  for (const [modelId, provider, document, query] of [
    ["voyage/voyage-4", "voyage", "document", "query"],
    ["voyage/voyage-4-lite", "voyage", "document", "query"],
    ["voyage/voyage-4-large", "voyage", "document", "query"],
    ["cohere/embed-v4.0", "cohere", "search_document", "search_query"],
  ] as const) {
    let calls = 0
    const gateway = createVercelGateway({
      fetch: async (_url, init) => {
        calls++
        const body = JSON.parse(String(init?.body))
        expect(body.dimensions).toBe(2)
        expect(body.providerOptions).toEqual({
          [provider]: {
            inputType: calls === 1 ? document : query,
            ...(provider === "voyage"
              ? { outputDimension: 2, truncation: false }
              : { truncate: "NONE" }),
          },
        })
        return Response.json({ data: [{ index: 0, embedding: [1, 0] }] })
      },
    })
    const model = gateway.embedding(modelId, { dimensions: 2 })
    expect(model.definition.inputMode).toBe("asymmetric")
    await expect(model.embed({ texts: ["ambiguous"] })).rejects.toThrow("purpose")
    expect(calls).toBe(0)
    await model.embed({ texts: ["document"], purpose: "document" })
    await model.embed({ texts: ["question"], purpose: "query" })
    expect(calls).toBe(2)
  }
})

test("unknown routes keep generic requests without inferred retrieval settings or batching", async () => {
  // Removal proof: restore startsWith("voyage/") / startsWith("cohere/") dispatch; this fails.
  for (const modelId of [
    "voyage/future-model",
    "voyage/voyage-4-large-preview",
    "cohere/embed-v4.0-preview",
    "cohere/embed-multilingual-v3.0",
    "other/embedding",
  ]) {
    let calls = 0
    const gateway = createVercelGateway({
      fetch: async (_url, init) => {
        calls++
        expect(JSON.parse(String(init?.body))).toEqual({
          model: modelId,
          input: ["text"],
          dimensions: 2,
          encoding_format: "float",
        })
        return Response.json({ data: [{ index: 0, embedding: [1, 0] }] })
      },
    })
    const model = gateway.embedding(modelId, { dimensions: 2 })
    expect(model.definition.inputMode).toBeUndefined()
    expect(model.batching).toBeUndefined()
    await model.embed({ texts: ["text"] })
    await model.embed({ texts: ["text"], purpose: "query" })
    expect(calls).toBe(2)
  }
})
