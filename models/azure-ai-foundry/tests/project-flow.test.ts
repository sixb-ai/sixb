import { expect, test } from "bun:test"
import { resolveLanguageModel } from "@sixb/core/internal/model-execution"
import { prepareAgentModel } from "../../../packages/agent/src/context-budget"
import { createAzureAIFoundry } from "../src"

const endpoint = "https://resource.services.ai.azure.com/api/projects/test"
const resource = "https://resource.services.ai.azure.com"
const deployment = {
  type: "ModelDeployment",
  name: "production",
  modelName: "future-model",
  modelVersion: "2026-09-01",
  modelPublisher: "OpenAI",
  sku: { name: "GlobalStandard" },
  capabilities: { chat_completion: "true" },
}

// Regression proof: expose options.definition on an unresolved Foundry binding again.
// Sixb's resolver mistakes either explicit context limit for an offline-ready model,
// and both generation resolution and worker admission fail before discovery runs.
test.each([
  "contextWindow",
  "maxInputTokens",
] as const)("Sixb resolves a cold Foundry binding with an explicit %s before worker admission", async (limit) => {
  for (const worker of [false, true]) {
    const calls: string[] = []
    const foundry = createAzureAIFoundry({
      endpoint,
      apiKey: "key",
      fetch: async (url) => {
        calls.push(String(url))
        return Response.json({ value: [deployment] })
      },
      catalog: {
        fetch: async () => {
          calls.push("catalog")
          return Response.json({
            azure: {
              models: {
                "future-model": {
                  id: "future-model",
                  modalities: { output: ["text"] },
                  limit: { context: 100000, output: 1000 },
                  tool_call: true,
                  cost: { input: 1, output: 2 },
                },
              },
            },
          })
        },
      },
    })
    const binding = foundry("production", { definition: { [limit]: 64000, capabilities: {} } })
    expect(calls).toEqual([])
    // A worker gets the model its session pinned, then budgets it.
    const prepared = worker
      ? prepareAgentModel({ model: await resolveLanguageModel(binding) })
      : undefined
    const model = prepared?.model ?? (await resolveLanguageModel(binding))
    expect(model.definition).toMatchObject({
      modelId: "production",
      [limit]: 64000,
      maxOutputTokens: 1000,
      capabilities: { localTools: true },
    })
    if (prepared)
      expect(prepared.budget).toMatchObject(
        limit === "contextWindow" ? { windowTokens: 64000 } : { inputBudgetTokens: 64000 }
      )
    expect(
      model.costEstimator?.estimate({ usage: { inputTokens: 10, outputTokens: 2 } })
    ).toMatchObject({ status: "rated" })
    expect(calls).toEqual([`${endpoint}/deployments?api-version=v1`, "catalog"])
    expect(binding.definition.contextWindow).toBeUndefined()
    expect(binding.definition.maxInputTokens).toBeUndefined()
  }
})

// Regression proof: run this file with the pre-refactor src files. The API-key
// provider skips discovery and cannot resolve the alias, capabilities or prices.
test("project URL and API key resolve an alias, enforce Sixb capabilities and price the streamed result", async () => {
  const calls: string[] = []
  let keyReads = 0
  const foundry = createAzureAIFoundry({
    endpoint,
    apiKey: () => `test-key-${++keyReads}`,
    fetch: async (url, init) => {
      calls.push(String(url))
      const headers = new Headers(init?.headers)
      expect(headers.get("api-key")).toBe(`test-key-${keyReads}`)
      expect(headers.has("authorization")).toBe(false)
      expect(init?.redirect).toBe("error")
      if (String(url).endsWith("/deployments?api-version=v1"))
        return Response.json({ value: [deployment] })
      expect(String(url)).toBe(`${resource}/openai/v1/responses`)
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "production",
        max_output_tokens: 100,
      })
      const response = { id: "r", model: "future-model-2026-09-01" }
      const usage = {
        input_tokens: 10,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
      }
      return new Response(
        [
          { type: "response.created", response },
          { type: "response.output_text.delta", item_id: "m", delta: "ok" },
          { type: "response.completed", response: { ...response, status: "completed", usage } },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("")
      )
    },
    catalog: {
      fetch: async (url, init) => {
        calls.push(String(url))
        expect(init?.headers).toBeUndefined()
        return Response.json({
          azure: {
            models: {
              "future-model": {
                id: "future-model",
                modalities: { output: ["text"] },
                limit: { context: 1000, output: 100 },
                tool_call: true,
                cost: { input: 1, output: 2, cache_read: 0.1 },
              },
            },
          },
        })
      },
    },
  })
  const handle = foundry("production")
  expect(calls).toEqual([])
  const [model, listed] = await Promise.all([handle.resolve(), foundry.catalog.get("production")])
  if (!listed) throw new Error("Resolved deployment missing from catalog")
  expect(model.definition).toEqual(listed)
  expect(model.definition).toMatchObject({
    modelId: "production",
    contextWindow: 1000,
    maxOutputTokens: 100,
    capabilities: { localTools: true },
  })
  expect(model.metadata).toMatchObject({ modelName: "future-model", modelVersion: "2026-09-01" })
  // Azure reports the publisher as OpenAI, and only `chat_completion` among its flags.
  expect(model.protocol).toBe("responses")
  const { events } = await handle.stream({
    callId: "test",
    messages: [],
    tools: [],
    maxOutputTokens: 200,
    signal: AbortSignal.timeout(1000),
  })
  let finished = false
  for await (const event of events) {
    if (event.type === "error") throw event.error
    if (event.type === "finish") {
      finished = true
      expect(
        handle.costEstimator.estimate({ usage: event.usage, route: event.route })
      ).toMatchObject({ status: "rated", money: { amountNanos: "14000" } })
    }
  }
  expect(finished).toBe(true)
  expect(handle.definition).toEqual(model.definition)
  expect(keyReads).toBe(2)
  expect(calls).toEqual([
    `${endpoint}/deployments?api-version=v1`,
    "https://models.dev/api.json",
    `${resource}/openai/v1/responses`,
  ])
})

test("discovery failure cannot fall back to an unverified inference binding", async () => {
  let calls = 0
  const foundry = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      calls++
      expect(init?.method).not.toBe("POST")
      return new Response(null, { status: 401 })
    },
  })
  await expect(
    foundry("production").stream({
      callId: "test",
      messages: [],
      tools: [],
      signal: AbortSignal.timeout(1000),
    })
  ).rejects.toThrow("catalog unavailable")
  expect(calls).toBe(1)
})

// Regression proof: remove the connectionName check in FoundryDeployments.resolve. The
// bindings then resolve, and their calls would go to a resource that lacks the deployment.
test("a deployment from a project connection is rejected for every protocol", async () => {
  const foundry = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () =>
      Response.json({ value: [{ ...deployment, connectionName: "other-resource" }] }),
    catalog: { fetch: async () => Response.json({ azure: { models: {} } }) },
  })
  expect(await foundry.catalog.list()).toEqual([])
  for (const binding of [
    foundry("production"),
    foundry.responses("production"),
    foundry.chat("production"),
    foundry.messages("production"),
  ])
    await expect(binding.resolve()).rejects.toThrow(
      "comes from project connection 'other-resource', on another resource"
    )
})

const noCatalog = { fetch: async () => Response.json({ azure: { models: {} } }) }
const hello = {
  callId: "test",
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 100,
  signal: AbortSignal.timeout(1000),
}
const answered = () => {
  const response = { id: "r", model: "future-model-2026-09-01" }
  const usage = { input_tokens: 1, output_tokens: 1 }
  return new Response(
    [
      { type: "response.created", response },
      { type: "response.completed", response: { ...response, status: "completed", usage } },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("")
  )
}

// Regression proof: drop the AZURE_AI_FOUNDRY_* defaults in createAzureAIFoundry. It then
// throws without an endpoint, and discovery sends no key.
test("connects from AZURE_AI_FOUNDRY_ENDPOINT and AZURE_AI_FOUNDRY_API_KEY, read for each call", async () => {
  const saved = [process.env.AZURE_AI_FOUNDRY_ENDPOINT, process.env.AZURE_AI_FOUNDRY_API_KEY]
  const keys: (string | null)[] = []
  try {
    process.env.AZURE_AI_FOUNDRY_ENDPOINT = endpoint
    process.env.AZURE_AI_FOUNDRY_API_KEY = "first-key"
    const foundry = createAzureAIFoundry({
      catalog: noCatalog,
      fetch: async (url, init) => {
        expect(String(url)).toBe(`${endpoint}/deployments?api-version=v1`)
        keys.push(new Headers(init?.headers).get("api-key"))
        return Response.json({ value: [deployment] })
      },
    })
    await foundry.catalog.refresh()
    process.env.AZURE_AI_FOUNDRY_API_KEY = "second-key"
    await foundry.catalog.refresh()
    expect(keys).toEqual(["first-key", "second-key"])
    delete process.env.AZURE_AI_FOUNDRY_API_KEY
    const missing = await foundry.catalog.refresh().catch((error: unknown) => error)
    expect(String((missing as Error).cause)).toContain("set AZURE_AI_FOUNDRY_API_KEY")
    delete process.env.AZURE_AI_FOUNDRY_ENDPOINT
    expect(() => createAzureAIFoundry()).toThrow("set AZURE_AI_FOUNDRY_ENDPOINT")
  } finally {
    for (const [name, value] of [
      ["AZURE_AI_FOUNDRY_ENDPOINT", saved[0]],
      ["AZURE_AI_FOUNDRY_API_KEY", saved[1]],
    ] as const)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
  }
})

// A cognitiveservices.azure.com token is refused by project discovery (measured November 2026).
// Regression proof: send the key headers beside the token in transport.ts headers(), or ask for
// another scope; the header or scope assertions fail.
test("an Entra ID credential signs discovery and every model call with one cached token", async () => {
  const scopes: unknown[] = []
  const sent: Headers[] = []
  const foundry = createAzureAIFoundry({
    endpoint,
    credential: {
      getToken: async (scope) => {
        scopes.push(scope)
        return { token: `token-${scopes.length}`, expiresOnTimestamp: Date.now() + 60 * 60_000 }
      },
    },
    catalog: noCatalog,
    fetch: async (url, init) => {
      sent.push(new Headers(init?.headers))
      if (String(url).endsWith("/deployments?api-version=v1"))
        return Response.json({ value: [deployment] })
      return answered()
    },
  })
  for await (const event of (await foundry("production").stream(hello)).events)
    if (event.type === "error") throw event.error
  await foundry.messages("production").stream(hello)
  expect(scopes).toEqual(["https://ai.azure.com/.default"])
  expect(sent).toHaveLength(3)
  for (const headers of sent) {
    expect(headers.get("authorization")).toBe("Bearer token-1")
    expect(headers.has("api-key")).toBe(false)
    expect(headers.has("x-api-key")).toBe(false)
  }
})

test("errors never show the bearer token", async () => {
  const foundry = createAzureAIFoundry({
    endpoint,
    credential: {
      getToken: async () => ({ token: "secret-token", expiresOnTimestamp: Date.now() + 3_600_000 }),
    },
    catalog: noCatalog,
    fetch: async (url, init) => {
      if (String(url).endsWith("/deployments?api-version=v1"))
        return Response.json({ value: [deployment] })
      const echoed = new Headers(init?.headers).get("authorization")
      return Response.json({ error: { message: `Refused ${echoed}` } }, { status: 400 })
    },
  })
  const error = await foundry("production")
    .stream(hello)
    .catch((failure: unknown) => failure)
  expect(String(error)).toContain("Refused Bearer [REDACTED]")
  expect(String(error)).not.toContain("secret-token")
})

test("takes apiKey or credential, not both, and refuses a blank key", () => {
  const credential = { getToken: async () => ({ token: "token" }) }
  expect(() => createAzureAIFoundry({ endpoint, apiKey: "key", credential })).toThrow(
    "either apiKey or credential"
  )
  expect(() => createAzureAIFoundry({ endpoint, apiKey: "   " })).toThrow(
    "apiKey or credential is required"
  )
  // @ts-expect-error A credential needs getToken.
  expect(() => createAzureAIFoundry({ endpoint, credential: {} })).toThrow("getToken")
})

test.each([
  "",
  "/openai/v1",
  "/api/projects/test/openai/v1",
])("requires a project URL rather than a resource/inference URL (%s)", (path) => {
  expect(() =>
    createAzureAIFoundry({
      endpoint: `https://resource.services.ai.azure.com${path}`,
      apiKey: "key",
    })
  ).toThrow("project URL")
})
