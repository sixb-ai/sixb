import { expect, test } from "bun:test"
import { ModelCatalogUnavailableError } from "@sixb/core/models"
import { createAzureAIFoundry } from "../src"

const endpoint = "https://resource.services.ai.azure.com"
const record = (cost = 2, tools = true) => ({
  id: "new-model",
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 100000, output: 8192 },
  tool_call: tools,
  structured_output: true,
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "high"] }],
  provider: { npm: "@ai-sdk/openai-compatible" },
  cost: { input: cost, output: 4, cache_read: 0.1 },
})
const page = (value = record()) => Response.json({ azure: { models: { "new-model": value } } })
const hint = { metadata: { modelName: "New-Model", modelVersion: "anything" } }
const usage = { inputTokens: 10, uncachedInputTokens: 10, cacheReadInputTokens: 0, outputTokens: 2 }

// Regression proof: remove the FW fallback in RemoteModelsDevCatalog.get; these bindings lose
// their capabilities and prices. Fictional versions ensure this isn't a curated model table.
test("resolves Fireworks naming conventions with Azure transport and pinned reference prices", async () => {
  let cost = 2
  let calls = 0
  let body: Record<string, unknown> | undefined
  const ids = [
    "accounts/fireworks/models/glm-5p3",
    "accounts/fireworks/routers/glm-5p2-fast",
    "accounts/fireworks/models/future-19p7-flash",
  ]
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (url, init) => {
      expect(String(url)).toStartWith(endpoint)
      body = JSON.parse(String(init?.body))
      return new Response("unused")
    },
    catalog: {
      fetch: async () => {
        calls++
        return Response.json({
          azure: { models: {} },
          "fireworks-ai": {
            models: Object.fromEntries(
              ids.map((id) => [id, { ...record(cost), id, provider: undefined }])
            ),
          },
        })
      },
    },
  })
  for (const [i, modelName] of [
    "FW-GLM-5.3",
    "fw-glm-5.2-fast",
    "FW-Future-19.7-Flash",
  ].entries()) {
    const binding = provider("production", { metadata: { modelName } })
    const model = await binding.resolve()
    expect(model.protocol).toBe("chat")
    expect(model.metadata.catalog).toMatchObject({
      provider: "fireworks-ai",
      modelId: ids[i],
      pricing: "reference",
    })
    expect(model.definition).toMatchObject({
      modelId: "production",
      contextWindow: 100000,
      capabilities: { localTools: true, reasoning: { efforts: ["low", "high"] } },
    })
    expect(model.costEstimator.estimate({ usage, responseModelId: modelName })).toMatchObject({
      money: { amountNanos: "28000" },
    })
    await model.stream({
      callId: "test",
      messages: [],
      tools: [],
      reasoning: "high",
      maxOutputTokens: 16,
      signal: AbortSignal.timeout(1000),
    })
    expect(body).toMatchObject({ model: "production", reasoning_effort: "high" })
  }
  expect(calls).toBe(1)
  const binding = provider("production", { metadata: { modelName: "FW-GLM-5.3" } })
  const original = await binding.resolve()
  cost = 3
  await provider.catalog.refresh()
  const next = await binding.resolve()
  expect(original.costEstimator.estimate({ usage })).toMatchObject({
    money: { amountNanos: "28000" },
  })
  expect(next.costEstimator.estimate({ usage })).toMatchObject({ money: { amountNanos: "38000" } })
  expect((await binding.resolve({ offline: true })).metadata.catalog).toEqual(next.metadata.catalog)
  expect(calls).toBe(2)
})

test("Fireworks fallback preserves Azure authority and rejects ambiguous, moving and variant matches", async () => {
  const ids = [
    "accounts/fireworks/models/glm-5p3",
    "accounts/fireworks/routers/glm-5p3",
    "accounts/fireworks/models/glm-5p2-fast",
    "accounts/fireworks/routers/glm-latest",
    "accounts/other/models/glm-5p4",
  ]
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    catalog: {
      fetch: async () =>
        Response.json({
          azure: { models: { "fw-glm-5.2-fast": { ...record(9, false), id: "fw-glm-5.2-fast" } } },
          "fireworks-ai": {
            models: Object.fromEntries(ids.map((id) => [id, { ...record(), id }])),
          },
        }),
    },
  })
  const azure = await provider("deployment", {
    metadata: { modelName: "FW-GLM-5.2-Fast" },
  }).resolve()
  expect(azure.metadata.catalog?.provider).toBe("azure")
  expect(azure.definition.capabilities.localTools).toBe(false)
  for (const modelName of [
    "FW-GLM-5.3",
    "FW-GLM-5.2",
    "FW-GLM-Latest",
    "FW-GLM-5.4",
    "GLM-5.2-Fast",
    "FW-GLM-5.2-Flash",
  ]) {
    const model = await provider("deployment", { metadata: { modelName } }).resolve()
    expect(model.metadata.catalog).toBeUndefined()
    expect(model.costEstimator.estimate({ usage }).status).toBe("unpriceable")
  }
})

// Regression proof: disable catalog loading in get(); new identities then have no capabilities
// or prices. No named-model table can satisfy this fixture.
test("models.dev supplies an unfamiliar model's capabilities, protocol, controls and reference prices", async () => {
  let calls = 0
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "secret",
    catalog: {
      fetch: async (url, init) => {
        calls++
        expect(String(url)).toBe("https://models.dev/api.json")
        expect(init?.headers).toBeUndefined()
        return page()
      },
    },
  })
  const binding = provider("production", hint)
  expect(calls).toBe(0)
  const [one, two] = await Promise.all([binding.resolve(), binding.resolve()])
  expect(calls).toBe(1)
  expect(one.protocol).toBe("chat")
  expect(one.definition).toMatchObject({
    modelId: "production",
    contextWindow: 100000,
    capabilities: {
      localTools: true,
      nativeStructuredOutput: true,
      reasoning: { efforts: ["low", "high"] },
    },
  })
  expect(one.definition.capabilities.parallelToolCalls).toBeUndefined()
  expect(two.definition).toEqual(one.definition)
  expect(binding.definition.contextWindow).toBeUndefined()
  expect(one.costEstimator.estimate({ usage, responseModelId: "new-model" })).toMatchObject({
    money: { amountNanos: "28000" },
  })
  expect(one.costEstimator.estimate({ usage, responseModelId: "different-model" }).status).toBe(
    "unpriceable"
  )
})

// Regression proof: remove catalog invalidation; refreshed rates/flags remain old. Read the
// estimator from a mutable shared card instead and the pinned old estimate changes.
test("refresh updates capabilities and prices together while existing models remain pinned", async () => {
  let cost = 2
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    catalog: { fetch: async () => page(record(cost, cost === 2)) },
  })
  const binding = provider("production", hint)
  const original = await binding.resolve()
  cost = 3
  await provider.catalog.refresh()
  const next = await binding.resolve()
  expect(next.definition.capabilities.localTools).toBe(false)
  expect(original.definition.capabilities.localTools).toBe(true)
  expect(original.costEstimator.estimate({ usage })).toMatchObject({
    money: { amountNanos: "28000" },
  })
  expect(next.costEstimator.estimate({ usage })).toMatchObject({ money: { amountNanos: "38000" } })
  expect(await original.resolve()).toBe(original)
})

test("expires/coalesces lookups, preserves offline snapshots on outages and rejects malformed catalogs", async () => {
  let calls = 0
  let broken = false
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    catalog: {
      ttlMs: 0,
      fetch: async () => {
        calls++
        if (broken) throw new Error("outage")
        return page()
      },
    },
  })
  const binding = provider("production", hint)
  await binding.resolve()
  await Promise.all([binding.resolve(), binding.resolve()])
  expect(calls).toBe(2)
  broken = true
  await expect(binding.resolve()).rejects.toBeInstanceOf(ModelCatalogUnavailableError)
  expect((await binding.resolve({ offline: true })).definition.contextWindow).toBe(100000)
  const malformed = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    catalog: { fetch: async () => Response.json({ azure: {} }) },
  })
  await expect(malformed("production", hint).resolve()).rejects.toThrow("azure.models")
})

test("honors explicit overrides, unknown identities, false capabilities and unsupported pricing dimensions", async () => {
  const raw = { ...record(), cost: { input: 1, output: 2, tiers: [{ input: 3 }] } }
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    catalog: { fetch: async () => Response.json({ azure: { models: { "new-model": raw } } }) },
  })
  const model = await provider("deployment", hint).resolve()
  expect(model.costEstimator.estimate({ usage }).status).toBe("unpriceable")
  const override = await provider("deployment", {
    ...hint,
    definition: { capabilities: { localTools: false } },
    rateCard: { currency: "USD", unit: "million-tokens", input: "1", output: "2" },
  }).resolve()
  expect(override.definition.capabilities.localTools).toBe(false)
  expect(override.costEstimator.estimate({ usage })).toMatchObject({
    money: { amountNanos: "14000" },
  })
  expect(
    (await provider("missing", { metadata: { modelName: "missing" } }).resolve()).definition
      .capabilities
  ).toEqual({})
})

test("deployment discovery supplies identity and routing, never overrides models.dev capabilities or limits", async () => {
  const provider = createAzureAIFoundry({
    endpoint: `${endpoint}/api/projects/test`,
    tokenProvider: () => "token",
    fetch: async () =>
      Response.json({
        value: [
          {
            type: "ModelDeployment",
            name: "production",
            modelName: "New-Model",
            modelVersion: "1",
            modelPublisher: "New",
            sku: { name: "GlobalStandard" },
            capabilities: { chat_completion: "true", maxContextToken: "42" },
          },
        ],
      }),
    catalog: { fetch: async () => page(record(2, false)) },
  })
  const model = await provider("production").resolve()
  expect(model.definition.contextWindow).toBe(100000)
  expect(model.definition.capabilities.localTools).toBe(false)
  expect((await provider.catalog.list())[0]).toEqual(model.definition)
})

test("derives Messages thinking controls from metadata, not model names", async () => {
  const raw = {
    ...record(),
    provider: { npm: "@ai-sdk/anthropic" },
    reasoning_options: [{ type: "budget_tokens", min: 1024 }],
  }
  let body: unknown
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_u, init) => {
      body = JSON.parse(String(init?.body))
      return new Response("unused")
    },
    catalog: { fetch: async () => Response.json({ azure: { models: { "new-model": raw } } }) },
  })
  const model = await provider("production", hint).resolve()
  expect(model.protocol).toBe("messages")
  await model.stream({
    callId: "test",
    messages: [],
    tools: [],
    reasoning: { budgetTokens: 1024 },
    maxOutputTokens: 2048,
    signal: AbortSignal.timeout(1000),
  })
  expect(body).toMatchObject({ thinking: { type: "enabled", budget_tokens: 1024 } })
})

test("bounds fetch and body waits independently of transport cancellation support", async () => {
  for (const fetch of [
    async () => new Promise<Response>(() => {}),
    async () => new Response(new ReadableStream()),
  ]) {
    const provider = createAzureAIFoundry({
      endpoint,
      apiKey: "key",
      catalog: { timeoutMs: 10, fetch },
    })
    await expect(provider("deployment", hint).resolve()).rejects.toBeInstanceOf(
      ModelCatalogUnavailableError
    )
  }
})
