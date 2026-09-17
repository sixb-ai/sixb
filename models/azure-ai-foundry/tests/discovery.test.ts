import { expect, spyOn, test } from "bun:test"
import {
  type JsonObject,
  type LanguageModelRequest,
  ModelCatalogUnavailableError,
  ModelProviderError,
} from "@sixb/core/models"
import { type AzureAIFoundryDiscoveryOptions, createAzureAIFoundry } from "../src"

const endpoint = "https://resource.services.ai.azure.com/api/projects/example"

function deployment(
  name = "production",
  capabilities: JsonObject = {
    responses: "true",
    maxContextToken: "128000",
    maxOutputToken: "8192",
  }
): JsonObject {
  return {
    type: "ModelDeployment",
    name,
    modelName: "publisher-model",
    modelPublisher: "OpenAI",
    modelVersion: "2026-01-01",
    capabilities,
    sku: { name: "GlobalStandard", capacity: 1 },
    connectionName: "resource-connection",
  }
}

function page(records: JsonObject[], nextLink?: string): Response {
  return Response.json({ value: records, ...(nextLink === undefined ? {} : { nextLink }) })
}

function request(): LanguageModelRequest {
  return {
    callId: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    signal: new AbortController().signal,
  }
}

function answer(): Response {
  return new Response(
    'data: {"type":"response.completed","response":{"status":"completed","model":"publisher-model-2026-01-01","usage":{"input_tokens":10,"output_tokens":2,"input_tokens_details":{"cached_tokens":0}}}}\n\n'
  )
}

// Live project deployments report chat_completion rather than ARM's chatCompletion.
// Regression proof: remove the alias lookup in discovery.ts flag(); the Chat list is empty.
test("recognizes live project Chat capability spelling without changing raw metadata", async () => {
  const provider = createAzureAIFoundry({
    endpoint,
    tokenProvider: () => "token",
    discovery: {},
    fetch: async () => page([deployment("live-chat", { chat_completion: "true" })]),
  })
  expect((await provider.catalog.list({ protocol: "chat" })).map((model) => model.modelId)).toEqual(
    ["live-chat"]
  )
  expect(await provider.catalog.list()).toEqual([])
  expect((await provider.catalog.deployments())[0]?.capabilities).toEqual({
    chat_completion: "true",
  })
})

test("rejects contradictory Chat capability aliases", async () => {
  const provider = createAzureAIFoundry({
    endpoint,
    tokenProvider: () => "token",
    discovery: {},
    fetch: async () =>
      page([deployment("conflict", { chat_completion: "true", chatCompletion: "false" })]),
  })
  await expect(provider.catalog.deployments()).rejects.toThrow("contradictory")
})

test("coalesces paginated discovery, refreshes tokens, and separates discovery from inference auth", async () => {
  const urls: string[] = []
  let tokens = 0
  let body: JsonObject | undefined
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "inference-key",
    headers: { "x-inference": "only" },
    discovery: {
      tokenProvider: async () => `token-${++tokens}`,
      headers: { "x-discovery": "only" },
    },
    fetch: async (url, init) => {
      urls.push(String(url))
      const headers = new Headers(init?.headers)
      if (String(url).endsWith("/responses")) {
        expect(headers.get("api-key")).toBe("inference-key")
        expect(headers.has("authorization")).toBe(false)
        expect(headers.get("x-inference")).toBe("only")
        body = JSON.parse(String(init?.body))
        return answer()
      }
      expect(headers.get("authorization")).toBe(`Bearer token-${tokens}`)
      expect(headers.has("api-key")).toBe(false)
      expect(headers.has("x-inference")).toBe(false)
      expect(headers.get("x-discovery")).toBe("only")
      expect(init?.redirect).toBe("error")
      return new URL(String(url)).searchParams.has("page")
        ? page([deployment("secondary")])
        : page([deployment()], "?api-version=v1&page=2")
    },
  })
  const original = provider("production")
  expect(urls).toEqual([])
  const [models, model, records] = await Promise.all([
    provider.catalog.list(),
    original.resolve(),
    provider.catalog.deployments(),
    provider.catalog.refresh(),
  ])
  expect(models.map((entry) => entry.modelId)).toEqual(["production", "secondary"])
  expect(urls).toEqual([
    `${endpoint}/deployments?api-version=v1`,
    `${endpoint}/deployments?api-version=v1&page=2`,
  ])
  expect(tokens).toBe(2)
  expect(model.definition).toMatchObject({
    modelId: "production",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    capabilities: {},
  })
  expect(model.metadata).toMatchObject({
    publisher: "OpenAI",
    modelName: "publisher-model",
    modelVersion: "2026-01-01",
    deployment: {
      name: "production",
      connectionName: "resource-connection",
      sku: { name: "GlobalStandard" },
    },
  })
  expect(model.metadata.discoveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(Object.isFrozen(records)).toBe(true)
  expect(Object.isFrozen(records[0]?.capabilities)).toBe(true)
  expect(Object.isFrozen(records[0]?.sku)).toBe(true)
  expect(original.definition.contextWindow).toBeUndefined()
  expect(original.metadata).toEqual({})
  for await (const _event of (await model.stream(request())).events) {
    /* consume */
  }
  expect(body).toMatchObject({ model: "production", max_output_tokens: 8192 })
  expect((await provider.catalog.get("secondary"))?.modelId).toBe("secondary")
  expect(urls).toHaveLength(3)
})

// Regression proof: return the cached definition instead of merging supplied/binding fields
// in discovery.ts/provider.ts. The explicit ceiling and false capability are then lost.
test("pins online/offline snapshots and preserves explicit configuration through refresh", async () => {
  let version = "2026-01-01"
  let maximum = "8192"
  let calls = 0
  let captured: JsonObject | undefined
  const provider = createAzureAIFoundry({
    endpoint,
    tokenProvider: () => "token",
    discovery: {},
    models: [
      {
        kind: "language",
        providerId: "azure-ai-foundry",
        modelId: "production",
        contextWindow: 2000,
        maxOutputTokens: 100,
        capabilities: { localTools: true, nativeStructuredOutput: true },
      },
    ],
    fetch: async (url, init) => {
      if (String(url).endsWith("/responses")) {
        captured = JSON.parse(String(init?.body))
        return answer()
      }
      calls++
      return page([
        {
          ...deployment("production", {
            responses: "true",
            maxContextToken: "128000",
            maxOutputToken: maximum,
          }),
          modelVersion: version,
        },
      ])
    },
  })
  const definition = { maxOutputTokens: 80, capabilities: { localTools: false } }
  const options = {
    definition,
    request: { temperature: 0.2 },
    rateCard: {
      currency: "USD" as const,
      unit: "million-tokens" as const,
      input: "2",
      output: "10",
      cacheReadInput: "1",
    },
  }
  const original = provider("production", options)
  const offlineBefore = await original.resolve({ offline: true })
  expect(calls).toBe(0)
  expect(offlineBefore.metadata.publisher).toBeUndefined()
  definition.maxOutputTokens = 999
  definition.capabilities.localTools = true
  options.request.temperature = 0.9
  options.rateCard.input = "999"
  const first = await original.resolve()
  expect(first.definition).toMatchObject({
    contextWindow: 2000,
    maxOutputTokens: 80,
    capabilities: { localTools: false, nativeStructuredOutput: true },
  })
  expect(await offlineBefore.resolve()).toBe(offlineBefore)
  expect(await first.resolve()).toBe(first)
  for await (const _event of (await first.stream(request())).events) {
    /* consume */
  }
  expect(captured).toMatchObject({ max_output_tokens: 80, temperature: 0.2 })
  expect(
    first.costEstimator?.estimate({
      usage: { inputTokens: 10, uncachedInputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0 },
      responseModelId: "publisher-model-2026-01-01",
    })
  ).toMatchObject({ status: "rated", money: { amountNanos: "40000" } })
  version = "2026-09-01"
  maximum = "4096"
  await Promise.all([provider.catalog.refresh(), provider.catalog.refresh()])
  expect(calls).toBe(2)
  expect(first.metadata.modelVersion).toBe("2026-01-01")
  const next = await original.resolve({ offline: true })
  expect(next.metadata.modelVersion).toBe("2026-09-01")
  expect(next.definition.maxOutputTokens).toBe(80)
  expect(original.metadata).toEqual({})
  expect(
    next.costEstimator?.estimate({
      usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0 },
      responseModelId: "publisher-model-2026-01-01",
    })
  ).toMatchObject({ status: "unpriceable" })
  expect(calls).toBe(2)
})

test("expires the cache and coalesces concurrent get/list calls after expiry", async () => {
  let calls = 0
  let now = Date.now()
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  try {
    const provider = createAzureAIFoundry({
      endpoint,
      tokenProvider: () => "token",
      discovery: { ttlMs: 100 },
      fetch: async () => {
        calls++
        return page([deployment()])
      },
    })
    await provider.catalog.list()
    now += 99
    await provider.catalog.get("production")
    expect(calls).toBe(1)
    now += 1
    await Promise.all([
      provider.catalog.list(),
      provider.catalog.get("production"),
      provider.catalog.deployments(),
    ])
    expect(calls).toBe(2)
  } finally {
    clock.mockRestore()
  }
})

test("retains unknown capability strings without inferring Responses, tools or strict schemas", async () => {
  const provider = createAzureAIFoundry({
    endpoint,
    tokenProvider: () => "token",
    discovery: {},
    fetch: async () =>
      page([
        deployment("yes", {
          responses: "true",
          chatCompletion: "false",
          jsonObjectResponse: "true",
          futureCapability: "future-value",
        }),
        deployment("no", { responses: "false", chatCompletion: "true" }),
        deployment("unknown", { chatCompletion: "true" }),
        { type: "FutureDeployment", name: "future" },
      ]),
  })
  const definitions = await provider.catalog.list()
  expect(definitions.map((entry) => entry.modelId)).toEqual(["yes"])
  expect(definitions[0]?.capabilities).toEqual({})
  expect(await provider.catalog.deployments()).toHaveLength(3)
  expect((await provider("yes").resolve()).metadata.deployment?.capabilities.futureCapability).toBe(
    "future-value"
  )
  expect((await provider("unknown").resolve()).metadata.modelName).toBe("publisher-model")
  await expect(provider("no").resolve()).rejects.toMatchObject({
    name: "UnsupportedModelFeatureError",
  })
})

test("keeps overlapping deployment names isolated by provider/project and rejects connection ambiguity", async () => {
  const providers = ["first", "second"].map((name) =>
    createAzureAIFoundry({
      endpoint: `${endpoint}-${name}`,
      providerId: name,
      tokenProvider: () => "token",
      discovery: {},
      fetch: async () => page([{ ...deployment(), modelName: name }]),
    })
  )
  const models = await Promise.all(providers.map((provider) => provider("production").resolve()))
  expect(
    models.map((model) => [model.providerId, model.modelId, model.metadata.modelName])
  ).toEqual([
    ["first", "production", "first"],
    ["second", "production", "second"],
  ])
  const ambiguous = createAzureAIFoundry({
    endpoint,
    tokenProvider: () => "token",
    discovery: {},
    fetch: async () =>
      page([deployment(), { ...deployment(), connectionName: "another-resource" }]),
  })
  await expect(ambiguous.catalog.list()).rejects.toThrow("unique across project connections")
})

// Regression proof: remove the same-project check in pageUrl. This follows the hostile
// continuation with a Bearer token instead of rejecting it before the second request.
test.each([
  "https://other.example/api/projects/example/deployments?page=2",
  "/api/projects/other/deployments?page=2",
  "/api/projects/example/openai/v1/responses",
  "https://user:password@resource.services.ai.azure.com/api/projects/example/deployments",
  "?api-version=preview",
  "?api-version=v1&api-version=preview",
  "?page=2#fragment",
])("rejects unsafe pagination target %s before sending credentials", async (nextLink) => {
  let calls = 0
  const provider = createAzureAIFoundry({
    endpoint,
    tokenProvider: () => "token",
    discovery: {},
    fetch: async () => {
      calls++
      return page([deployment()], nextLink)
    },
  })
  await expect(provider.catalog.list()).rejects.toBeInstanceOf(ModelProviderError)
  expect(calls).toBe(1)
})

const bounds: [AzureAIFoundryDiscoveryOptions, string][] = [
  [{ maxPages: 1 }, "maxPages"],
  [{ maxDeployments: 1 }, "maxDeployments"],
  [{ maxResponseBytes: 4 }, "maxResponseBytes"],
]
test.each(bounds)("bounds discovery (%j)", async (discovery, message) => {
  let calls = 0
  const provider = createAzureAIFoundry({
    endpoint,
    tokenProvider: () => "token",
    discovery,
    fetch: async () => page([deployment(String(++calls))], `?page=${calls + 1}`),
  })
  await expect(provider.catalog.list()).rejects.toThrow(message)
  expect(calls).toBeLessThanOrEqual(2)
})

test("detects repeated nextLink URLs and publishes no partial snapshot", async () => {
  let calls = 0
  const provider = createAzureAIFoundry({
    endpoint,
    tokenProvider: () => "token",
    discovery: {},
    fetch: async () => {
      calls++
      return page([deployment()], "?api-version=v1")
    },
  })
  await expect(provider.catalog.list()).rejects.toThrow("repeated a page")
  expect(calls).toBe(1)
  expect(
    (await provider("production").resolve({ offline: true })).metadata.deployment
  ).toBeUndefined()
})

test("applies the byte budget across pages and keeps the previous snapshot after a partial refresh", async () => {
  const first = { value: [deployment("new-first")], nextLink: "?page=2" }
  const byteLimit = Buffer.byteLength(JSON.stringify(first)) + 10
  let refreshing = false
  const provider = createAzureAIFoundry({
    endpoint,
    tokenProvider: () => "token",
    discovery: { maxResponseBytes: byteLimit },
    fetch: async (url) => {
      if (!refreshing) return page([deployment("original")])
      return String(url).includes("page=2")
        ? page([deployment("new-second")])
        : Response.json(first)
    },
  })
  await provider.catalog.list()
  refreshing = true
  await expect(provider.catalog.refresh()).rejects.toThrow("maxResponseBytes")
  expect((await provider("original").resolve({ offline: true })).metadata.modelName).toBe(
    "publisher-model"
  )
  expect(
    (await provider("new-first").resolve({ offline: true })).metadata.deployment
  ).toBeUndefined()
})

test("cancels a late response from a transport that ignored the discovery deadline", async () => {
  let finishFetch: (response: Response) => void = () => {
    throw new Error("fetch not started")
  }
  let confirmCancellation: () => void = () => {}
  const cancelled = new Promise<void>((resolve) => {
    confirmCancellation = resolve
  })
  const provider = createAzureAIFoundry({
    endpoint,
    tokenProvider: () => "token",
    discovery: { timeoutMs: 20 },
    fetch: () =>
      new Promise<Response>((resolve) => {
        finishFetch = resolve
      }),
  })
  await expect(provider.catalog.list()).rejects.toBeInstanceOf(ModelCatalogUnavailableError)
  finishFetch(
    new Response(
      new ReadableStream({
        cancel() {
          confirmCancellation()
        },
      })
    )
  )
  await cancelled
})

const malformed: JsonObject[] = [
  { capabilities: { responses: true } },
  { capabilities: { responses: "FALSE" } },
  { capabilities: { chatCompletion: "yes" } },
  { capabilities: { maxContextToken: "128k" } },
  { capabilities: { maxOutputToken: "9007199254740992" } },
  { capabilities: { maxOutputToken: "0" } },
  { modelPublisher: 123 },
  { modelVersion: null },
  { sku: { name: "sku", capacity: -1 } },
  { name: "" },
]
test.each(
  malformed
)("rejects malformed metadata without treating it as an outage (%j)", async (override) => {
  const provider = createAzureAIFoundry({
    endpoint,
    tokenProvider: () => "token",
    discovery: {},
    fetch: async () => page([{ ...deployment(), ...override }]),
  })
  await expect(provider("production").resolve()).rejects.toBeInstanceOf(ModelProviderError)
})

test("classifies transport/access failures, retries later, and retains the last complete offline snapshot", async () => {
  let mode = "ok"
  let calls = 0
  const provider = createAzureAIFoundry({
    endpoint,
    tokenProvider: () => "token",
    discovery: {},
    fetch: async () => {
      calls++
      if (mode === "network") throw new TypeError("offline")
      if (mode === "access")
        return new Response("private body", {
          status: 403,
          headers: { "apim-request-id": "failed-request" },
        })
      if (mode === "body")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("disconnected"))
            },
          })
        )
      if (mode === "json") return new Response("{broken")
      if (mode === "shape") return Response.json({ wrong: [] })
      return page([deployment()])
    },
  })
  await provider.catalog.list()
  for (const failure of ["network", "access", "body"]) {
    mode = failure
    await expect(provider.catalog.refresh()).rejects.toBeInstanceOf(ModelCatalogUnavailableError)
    const before = calls
    expect((await provider("production").resolve({ offline: true })).definition.contextWindow).toBe(
      128000
    )
    expect(calls).toBe(before)
    await expect(provider.catalog.list()).rejects.toBeInstanceOf(ModelCatalogUnavailableError)
    expect(calls).toBe(before + 1)
  }
  for (const malformed of ["json", "shape"]) {
    mode = malformed
    await expect(provider.catalog.refresh()).rejects.toBeInstanceOf(ModelProviderError)
  }
  mode = "ok"
  expect(await provider.catalog.list()).toHaveLength(1)
})

test.each([
  "credential",
  "fetch",
  "body",
])("bounds a stalled %s with one discovery deadline", async (stage) => {
  let cancelled = false
  let signal: AbortSignal | undefined
  const provider = createAzureAIFoundry({
    endpoint,
    tokenProvider: (current) => {
      signal = current
      return stage === "credential" ? new Promise<string>(() => {}) : "token"
    },
    discovery: { timeoutMs: 20 },
    fetch: async () => {
      if (stage === "fetch") return new Promise<Response>(() => {})
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        })
      )
    },
  })
  await expect(provider.catalog.list()).rejects.toBeInstanceOf(ModelCatalogUnavailableError)
  expect(signal?.aborted).toBe(true)
  if (stage === "body") expect(cancelled).toBe(true)
})

test("leaves key-only/offline configurations usable and validates discovery prerequisites", async () => {
  expect(() => createAzureAIFoundry({ endpoint, apiKey: "key", discovery: {} })).toThrow(
    "inference API key is insufficient"
  )
  expect(() =>
    createAzureAIFoundry({
      endpoint: "https://resource.openai.azure.com",
      tokenProvider: () => "token",
      discovery: {},
    })
  ).toThrow("project inference endpoint")
  for (const discovery of [{ maxPages: 0 }, { ttlMs: -1 }, { timeoutMs: Number.NaN }])
    expect(() =>
      createAzureAIFoundry({ endpoint, tokenProvider: () => "token", discovery })
    ).toThrow("positive safe integer")
  const offline = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () => {
      throw new Error("must not fetch")
    },
  })
  expect(await offline.catalog.list()).toEqual([])
  expect(await offline.catalog.refresh()).toEqual([])
  expect(await offline.catalog.deployments()).toEqual([])
  const model = offline("production")
  expect(await model.resolve()).toBe(model)
})
