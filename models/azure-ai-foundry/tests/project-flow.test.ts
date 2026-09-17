import { expect, test } from "bun:test"
import { resolveLanguageModel } from "@sixb/core/internal/model-execution"
import { prepareAgentModel } from "../../../packages/agent-worker/src/context-budget"
import { createAzureAIFoundry } from "../src"

const endpoint = "https://resource.services.ai.azure.com/api/projects/test"
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
    const prepared = worker ? await prepareAgentModel({ model: binding }) : undefined
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
      expect(String(url)).toBe(`${endpoint}/openai/v1/chat/completions`)
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "production",
        max_completion_tokens: 100,
      })
      return new Response(
        'data: {"id":"r","model":"future-model-2026-09-01","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":0}}}\n\ndata: [DONE]\n\n'
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
  expect(model.protocol).toBe("chat")
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
    `${endpoint}/openai/v1/chat/completions`,
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

test("native Messages rejects connected deployments whose resource cannot be inferred", async () => {
  const foundry = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () =>
      Response.json({ value: [{ ...deployment, connectionName: "other-resource" }] }),
    catalog: { fetch: async () => Response.json({ azure: { models: {} } }) },
  })
  expect(await foundry.catalog.list({ protocol: "messages" })).toEqual([])
  await expect(foundry.messages("production").resolve()).rejects.toThrow(
    "owning resource's project URL"
  )
})

// The old optional apiKey accepted these configurations at construction.
test.each([undefined, "", "   "])("requires an explicit nonempty API key (%j)", (apiKey) => {
  expect(() => createAzureAIFoundry({ endpoint, apiKey })).toThrow("apiKey is required")
})

test.each([
  "",
  "/openai/v1",
  "/anthropic/v1",
  "/api/projects/test/openai/v1",
])("requires a project URL rather than a resource/inference URL (%s)", (path) => {
  expect(() =>
    createAzureAIFoundry({
      endpoint: `https://resource.services.ai.azure.com${path}`,
      apiKey: "key",
    })
  ).toThrow("project URL")
})
