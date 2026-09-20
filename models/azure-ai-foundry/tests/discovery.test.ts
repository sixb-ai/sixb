import { expect, spyOn, test } from "bun:test"
import {
  type JsonObject,
  type LanguageModelRequest,
  ModelCatalogUnavailableError,
  ModelProviderError,
} from "@sixb/core/models"
import { type AzureAIFoundryDiscoveryOptions, createAzureAIFoundry } from "../src"

const create = createAzureAIFoundry
const providerFixture = (options: Parameters<typeof create>[0]) =>
  create({
    ...options,
    catalog: { fetch: async () => Response.json({ azure: { models: {} } }) },
  })
const endpoint = "https://resource.services.ai.azure.com/api/projects/example"

// Removal proof: remove the Messages fallback in resolveModel, or its BOOLEAN_KEYS entry.
test("routes uncataloged Messages deployments and validates their eligibility", async () => {
  let messages = "true"
  const provider = providerFixture({
    endpoint,
    apiKey: "key",
    fetch: async () =>
      Response.json({
        value: [
          {
            ...deployment("production", { messages, responses: "false", chat_completion: "false" }),
            connectionName: undefined,
          },
        ],
      }),
  })
  expect((await provider("production").resolve()).protocol).toBe("messages")
  expect((await provider.catalog.list()).map((entry) => entry.modelId)).toEqual(["production"])
  messages = "invalid"
  await expect(provider.catalog.refresh()).rejects.toThrow("capability 'messages'")
})

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
// Regression proof: remove the chat_completion alias in profile/catalog selection; the list is empty.
test("recognizes live project Chat capability spelling without changing raw metadata", async () => {
  const provider = providerFixture({
    endpoint,
    apiKey: () => "token",
    discovery: {},
    fetch: async () => page([deployment("live-chat", { chat_completion: "true" })]),
  })
  expect((await provider.catalog.list({ protocol: "chat" })).map((model) => model.modelId)).toEqual(
    ["live-chat"]
  )
  expect((await provider.catalog.list()).map((model) => model.modelId)).toEqual(["live-chat"])
  expect(await provider.catalog.list({ protocol: "responses" })).toEqual([])
  expect((await provider.catalog.deployments())[0]?.capabilities).toEqual({
    chat_completion: "true",
  })
})

test("rejects contradictory Chat capability aliases", async () => {
  const provider = providerFixture({
    endpoint,
    apiKey: () => "token",
    discovery: {},
    fetch: async () =>
      page([deployment("conflict", { chat_completion: "true", chatCompletion: "false" })]),
  })
  await expect(provider.catalog.deployments()).rejects.toThrow("contradictory")
})

test("coalesces paginated discovery and shares refreshed API keys and headers with inference", async () => {
  const urls: string[] = []
  let tokens = 0
  let body: JsonObject | undefined
  const provider = providerFixture({
    endpoint,
    apiKey: async () => `token-${++tokens}`,
    headers: { "x-custom": "shared" },
    fetch: async (url, init) => {
      urls.push(String(url))
      const headers = new Headers(init?.headers)
      if (String(url).endsWith("/responses")) {
        expect(headers.get("api-key")).toBe(`token-${tokens}`)
        expect(headers.has("authorization")).toBe(false)
        expect(headers.get("x-custom")).toBe("shared")
        body = JSON.parse(String(init?.body))
        return answer()
      }
      expect(headers.get("api-key")).toBe(`token-${tokens}`)
      expect(headers.has("authorization")).toBe(false)
      expect(headers.get("x-custom")).toBe("shared")
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
  expect(body).toMatchObject({ model: "production" })
  expect(body?.max_output_tokens).toBeUndefined()
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
  const provider = providerFixture({
    endpoint,
    apiKey: () => "token",
    discovery: {},
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
  const definition = {
    contextWindow: 2000,
    maxOutputTokens: 80,
    capabilities: { localTools: false, nativeStructuredOutput: true },
  }
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
  await expect(original.resolve({ offline: true })).rejects.toThrow("not found")
  expect(calls).toBe(0)
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
    const provider = providerFixture({
      endpoint,
      apiKey: () => "token",
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
  const provider = providerFixture({
    endpoint,
    apiKey: () => "token",
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
  const definitions = await provider.catalog.list({ protocol: "responses" })
  expect(definitions.map((entry) => entry.modelId)).toEqual(["yes"])
  expect(definitions[0]?.capabilities).toEqual({})
  expect(await provider.catalog.deployments()).toHaveLength(3)
  expect((await provider("yes").resolve()).metadata.deployment?.capabilities.futureCapability).toBe(
    "future-value"
  )
  expect((await provider("unknown").resolve()).metadata.modelName).toBe("publisher-model")
  expect((await provider("no").resolve()).protocol).toBe("chat")
  await expect(provider.responses("no").resolve()).rejects.toMatchObject({
    name: "UnsupportedModelFeatureError",
  })
})

test("keeps overlapping deployment names isolated by provider/project and rejects connection ambiguity", async () => {
  const providers = ["first", "second"].map((name) =>
    providerFixture({
      endpoint: `${endpoint}-${name}`,
      providerId: name,
      apiKey: () => "token",
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
  const ambiguous = providerFixture({
    endpoint,
    apiKey: () => "token",
    discovery: {},
    fetch: async () =>
      page([deployment(), { ...deployment(), connectionName: "another-resource" }]),
  })
  await expect(ambiguous.catalog.list()).rejects.toThrow("unique across project connections")
})

// Regression proof: remove the same-project check in pageUrl. This follows the hostile
// continuation with an API key instead of rejecting it before the second request.
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
  const provider = providerFixture({
    endpoint,
    apiKey: () => "token",
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
  const provider = providerFixture({
    endpoint,
    apiKey: () => "token",
    discovery,
    fetch: async () => page([deployment(String(++calls))], `?page=${calls + 1}`),
  })
  await expect(provider.catalog.list()).rejects.toThrow(message)
  expect(calls).toBeLessThanOrEqual(2)
})

test("detects repeated nextLink URLs and publishes no partial snapshot", async () => {
  let calls = 0
  const provider = providerFixture({
    endpoint,
    apiKey: () => "token",
    discovery: {},
    fetch: async () => {
      calls++
      return page([deployment()], "?api-version=v1")
    },
  })
  await expect(provider.catalog.list()).rejects.toThrow("repeated a page")
  expect(calls).toBe(1)
  await expect(provider("production").resolve({ offline: true })).rejects.toThrow("not found")
})

test("applies the byte budget across pages and keeps the previous snapshot after a partial refresh", async () => {
  const first = { value: [deployment("new-first")], nextLink: "?page=2" }
  const byteLimit = Buffer.byteLength(JSON.stringify(first)) + 10
  let refreshing = false
  const provider = providerFixture({
    endpoint,
    apiKey: () => "token",
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
  await expect(provider("new-first").resolve({ offline: true })).rejects.toThrow("not found")
})

test("cancels a late response from a transport that ignored the discovery deadline", async () => {
  let finishFetch: (response: Response) => void = () => {
    throw new Error("fetch not started")
  }
  let confirmCancellation: () => void = () => {}
  const cancelled = new Promise<void>((resolve) => {
    confirmCancellation = resolve
  })
  const provider = providerFixture({
    endpoint,
    apiKey: () => "token",
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
  const provider = providerFixture({
    endpoint,
    apiKey: () => "token",
    discovery: {},
    fetch: async () => page([{ ...deployment(), ...override }]),
  })
  await expect(provider("production").resolve()).rejects.toBeInstanceOf(ModelProviderError)
})

test("classifies transport/access failures, retries later, and retains the last complete offline snapshot", async () => {
  let mode = "ok"
  let calls = 0
  const provider = providerFixture({
    endpoint,
    apiKey: () => "token",
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
    expect((await provider("production").resolve({ offline: true })).metadata.modelName).toBe(
      "publisher-model"
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
  const provider = providerFixture({
    endpoint,
    apiKey: (current) => {
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

test("requires project URLs and validates discovery bounds", () => {
  expect(() =>
    providerFixture({ endpoint: "https://resource.openai.azure.com", apiKey: "key" })
  ).toThrow("project URL")
  for (const discovery of [{ maxPages: 0 }, { ttlMs: -1 }, { timeoutMs: Number.NaN }])
    expect(() => providerFixture({ endpoint, apiKey: "key", discovery })).toThrow(
      "positive safe integer"
    )
})
