import { expect, test } from "bun:test"
import { ModelCatalogUnavailableError } from "@sixb/core/models"
import { type AzureAIFoundryOptions, createAzureAIFoundry as create } from "../src"
import { foundryMessagesUsage } from "../src/messages-accounting"

const endpoint = "https://resource.services.ai.azure.com/api/projects/test"
const fixtureNames = [
  "production",
  "deployment",
  "missing",
  "FW-GLM-5.3",
  "fw-glm-5.2-fast",
  "FW-Future-19.7-Flash",
  "FW-GLM-5.2-Fast",
  "FW-GLM-5.2",
  "FW-GLM-Latest",
  "FW-GLM-5.4",
  "GLM-5.2-Fast",
  "FW-GLM-5.2-Flash",
]
function createAzureAIFoundry(options: AzureAIFoundryOptions) {
  return create({
    ...options,
    fetch: async (url, init) => {
      if (String(url).includes("/deployments?"))
        return Response.json({
          value: fixtureNames.map((name) => ({
            type: "ModelDeployment",
            name,
            modelName: ["production", "deployment"].includes(name) ? "New-Model" : name,
            modelVersion: "anything",
            modelPublisher: "Fixture",
            sku: { name: "GlobalStandard" },
            capabilities: { responses: "true" },
          })),
        })
      if (!options.fetch) throw new Error("Unexpected inference")
      return options.fetch(url, init)
    },
  })
}
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
const usage = { inputTokens: 10, uncachedInputTokens: 10, cacheReadInputTokens: 0, outputTokens: 2 }

// Removal proof: remove the catalog-only fallback in FoundryModel.resolve. Both explicit
// resolution and the first direct stream fail before reaching healthy Azure inference.
test("uses explicit definitions during a public catalog outage without bypassing Azure discovery", async () => {
  let inferenceCalls = 0
  let missing = false
  let malformed = false
  const provider = create({
    endpoint,
    apiKey: "key",
    fetch: async (url) => {
      if (String(url).includes("/deployments?"))
        return Response.json({
          value: missing
            ? []
            : [
                {
                  type: "ModelDeployment",
                  name: "production",
                  modelName: "new-model",
                  modelVersion: "1",
                  modelPublisher: "partner",
                  capabilities: { responses: "true" },
                  sku: { name: "GlobalStandard" },
                },
              ],
        })
      inferenceCalls++
      return new Response(
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
      )
    },
    catalog: {
      fetch: async () => {
        if (malformed) return Response.json({ azure: {} })
        throw new Error("outage")
      },
    },
  })
  const options = {
    definition: { contextWindow: 10000, maxOutputTokens: 100, capabilities: {} },
    rateCard: { currency: "USD", unit: "million-tokens", input: "1", output: "2" } as const,
  }
  const model = await provider.responses("production", options).resolve()
  expect(model.definition.contextWindow).toBe(10000)
  expect(model.metadata.catalog).toBeUndefined()
  expect(model.costEstimator.estimate({ usage })).toMatchObject({ status: "rated" })
  const stream = await provider.responses("production", options).stream({
    callId: "test",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  })
  for await (const event of stream.events) expect(event.type).not.toBe("error")
  expect(inferenceCalls).toBe(1)
  await expect(provider("production").resolve()).rejects.toBeInstanceOf(
    ModelCatalogUnavailableError
  )
  malformed = true
  await expect(provider.responses("production", options).resolve()).rejects.toThrow("azure.models")
  missing = true
  expect(await provider.catalog.refresh()).toEqual([])
  await expect(provider.responses("production", options).resolve()).rejects.toThrow("not found")
  expect(inferenceCalls).toBe(1)
})

// Removal proof: remove Foundry's publisher mapping; Azure models lose their author,
// and Fireworks models display the host instead of the catalog family's publisher.
test("publishes model authors from Azure or Fireworks catalog families with explicit overrides", async () => {
  const fixtures = [
    {
      name: "production",
      modelName: "new-model",
      publisher: "OpenAI",
      family: "gpt-mini",
      expected: { id: "openai", name: "OpenAI" },
    },
    {
      name: "glm",
      modelName: "FW-GLM-5.3",
      publisher: "Fireworks",
      family: "glm",
      expected: { id: "zai", name: "Z.ai" },
    },
    {
      name: "kimi",
      modelName: "FW-Kimi-K3",
      publisher: "Fireworks",
      family: "kimi-k3",
      expected: { id: "moonshotai", name: "Moonshot AI" },
    },
    {
      name: "deepseek",
      modelName: "FW-DeepSeek-V4-Flash-0731",
      publisher: "Fireworks",
      family: "deepseek-flash",
      expected: { id: "deepseek", name: "DeepSeek" },
    },
    {
      name: "unknown",
      modelName: "FW-Unknown",
      publisher: "Fireworks",
      family: "unknown",
      expected: { id: "fireworks-ai", name: "Fireworks" },
    },
    {
      name: "gpt-pretender",
      modelName: "unknown",
      publisher: "Future Lab",
      family: "unknown",
      expected: { id: "future-lab", name: "Future Lab" },
    },
  ]
  const provider = create({
    endpoint,
    apiKey: "key",
    providerId: "company-foundry",
    fetch: async () =>
      Response.json({
        value: fixtures.map((f) => ({
          type: "ModelDeployment",
          name: f.name,
          modelName: f.modelName,
          modelVersion: "1",
          modelPublisher: f.publisher,
          sku: { name: "GlobalStandard" },
          capabilities: { chatCompletion: "true" },
        })),
      }),
    catalog: {
      fetch: async () =>
        Response.json({
          azure: { models: { "new-model": record() } },
          "fireworks-ai": {
            models: Object.fromEntries(
              fixtures
                .filter((f) => f.publisher === "Fireworks")
                .map((f) => {
                  const id = `accounts/fireworks/models/${f.modelName.slice(3).toLowerCase()}`
                  return [id, { ...record(), id, family: f.family }]
                })
            ),
          },
        }),
    },
  })
  const listed = await provider.catalog.list()
  for (const fixture of fixtures) {
    const model = await provider(fixture.name).resolve()
    expect(model.definition).toMatchObject({
      providerId: "company-foundry",
      modelId: fixture.name,
      publisher: fixture.expected,
      via: "Azure AI Foundry",
    })
    expect(listed.find((d) => d.modelId === fixture.name)?.publisher).toEqual(fixture.expected)
    expect((await provider(fixture.name).resolve({ offline: true })).definition.publisher).toEqual(
      fixture.expected
    )
  }
  const override = await provider("production", {
    definition: { capabilities: {}, publisher: { id: "custom", name: "Custom" } },
  }).resolve()
  expect(override.definition.publisher).toEqual({ id: "custom", name: "Custom" })
})

// Regression proof: restore the per-deployment catalog.get() in provider.list(); each
// operation downloads three catalogs and the deployment definitions use different snapshots.
test("uses one fresh catalog snapshot per list, get and refresh when caching is disabled", async () => {
  let calls = 0
  const names = ["one", "two", "three"]
  const provider = create({
    endpoint,
    apiKey: "key",
    fetch: async () =>
      Response.json({
        value: names.map((name) => ({
          type: "ModelDeployment",
          name,
          modelName: "New-Model",
          modelVersion: "1",
          modelPublisher: "Fixture",
          sku: { name: "GlobalStandard" },
          capabilities: { chatCompletion: "true" },
        })),
      }),
    catalog: {
      ttlMs: 0,
      fetch: async () => {
        calls++
        return page({ ...record(), limit: { context: calls * 1000, output: 8192 } })
      },
    },
  })
  for (const operation of [() => provider.catalog.list(), () => provider.catalog.refresh()]) {
    const before = calls
    const definitions = await operation()
    expect(calls).toBe(before + 1)
    expect(definitions.map((d) => d.modelId)).toEqual(names)
    expect(definitions.map((d) => d.contextWindow)).toEqual(names.map(() => calls * 1000))
  }
  expect((await provider.catalog.get("two"))?.contextWindow).toBe(3000)
  expect(calls).toBe(3)
})

// Regression proof: restore generic cacheWriteInput for Messages reference prices;
// one-hour writes become rated. Remove the Messages reservation TTL guard and the
// one-hour reservation uses the cheaper five-minute rate. Run with -t "Messages reference".
test.each([
  false,
  true,
])("Messages reference cache writes retain their TTL with tiers=%s", async (tiered) => {
  const base = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }
  const high = { input: 6, output: 30, cache_read: 0.6, cache_write: 7.5 }
  const raw = {
    ...record(),
    provider: { npm: "@ai-sdk/anthropic" },
    cost: {
      ...base,
      ...(tiered
        ? {
            tiers: [{ ...high, tier: { type: "context", size: 200000 } }],
            context_over_200k: high,
          }
        : {}),
    },
  }
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    catalog: { fetch: async () => page(raw) },
  })
  for (const ttl of ["5m", "1h"] as const) {
    const model = await provider
      .messages("production", {
        request: { cache_control: { type: "ephemeral", ttl } },
      })
      .resolve()
    const estimate = model.costEstimator.estimate({
      usage: foundryMessagesUsage({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 1000000,
        cache_creation: {
          ephemeral_5m_input_tokens: ttl === "5m" ? 1000000 : 0,
          ephemeral_1h_input_tokens: ttl === "1h" ? 1000000 : 0,
        },
      }),
    })
    const reservation = model.costEstimator.estimateReservation?.({
      inputTokens: 1000000,
      outputTokens: 0,
    })
    if (ttl === "5m") {
      const money = { currency: "USD", amountNanos: tiered ? "7500000000" : "3750000000" } as const
      expect(estimate).toMatchObject({ status: "rated", money })
      expect(reservation).toEqual(money)
    } else {
      expect(estimate).toMatchObject({
        status: "unpriceable",
        missingMeters: ["tokens.input.cacheWrite1h"],
      })
      expect(reservation).toBeUndefined()
    }
  }
  const explicit = await provider
    .messages("production", {
      request: { cache_control: { type: "ephemeral", ttl: "1h" } },
      rateCard: {
        currency: "USD",
        unit: "million-tokens",
        input: "3",
        output: "15",
        cacheWriteInput5m: "3.75",
        cacheWriteInput1h: "6",
      },
    })
    .resolve()
  expect(
    explicit.costEstimator.estimateReservation?.({ inputTokens: 1000000, outputTokens: 0 })
  ).toEqual({ currency: "USD", amountNanos: "6000000000" })
})

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
    const binding = provider(modelName)
    const model = await binding.resolve()
    expect(model.protocol).toBe("chat")
    expect(model.metadata.catalog).toMatchObject({
      provider: "fireworks-ai",
      modelId: ids[i],
      pricing: "reference",
    })
    expect(model.definition).toMatchObject({
      modelId: modelName,
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
    expect(body).toMatchObject({ model: modelName, reasoning_effort: "high" })
  }
  expect(calls).toBe(1)
  const binding = provider("FW-GLM-5.3")
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
  const azure = await provider("FW-GLM-5.2-Fast").resolve()
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
    const model = await provider(modelName).resolve()
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
  const binding = provider("production")
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
  const binding = provider("production")
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
  const binding = provider("production")
  await binding.resolve()
  await Promise.all([binding.resolve(), binding.resolve()])
  expect(calls).toBe(2)
  broken = true
  // Removal proof: remove the catalog-only fallback in FoundryModel.resolve.
  expect((await binding.resolve()).definition.contextWindow).toBe(100000)
  expect((await binding.resolve({ offline: true })).definition.contextWindow).toBe(100000)
  const malformed = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    catalog: { fetch: async () => Response.json({ azure: {} }) },
  })
  await expect(malformed("production").resolve()).rejects.toThrow("azure.models")
})

test("honors explicit overrides, unknown identities, false capabilities and unsupported pricing dimensions", async () => {
  const raw = { ...record(), cost: { input: 1, output: 2, tiers: [{ input: 3 }] } }
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    catalog: { fetch: async () => Response.json({ azure: { models: { "new-model": raw } } }) },
  })
  const model = await provider("deployment").resolve()
  expect(model.costEstimator.estimate({ usage }).status).toBe("unpriceable")
  const override = await provider("deployment", {
    definition: { capabilities: { localTools: false } },
    rateCard: { currency: "USD", unit: "million-tokens", input: "1", output: "2" },
  }).resolve()
  expect(override.definition.capabilities.localTools).toBe(false)
  expect(override.costEstimator.estimate({ usage })).toMatchObject({
    money: { amountNanos: "14000" },
  })
  expect((await provider("missing").resolve()).definition.capabilities).toEqual({})
})

test("deployment discovery supplies identity and routing, never overrides models.dev capabilities or limits", async () => {
  const provider = create({
    endpoint,
    apiKey: () => "token",
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
  const model = await provider("production").resolve()
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
    await expect(provider("deployment").resolve()).rejects.toBeInstanceOf(
      ModelCatalogUnavailableError
    )
  }
})
