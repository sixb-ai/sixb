import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type ModelCatalogInput,
  type OntologySource,
  prop,
  SixbHost,
} from "@sixb/core"
import {
  type LanguageModelDisplayResolver,
  ModelsDevDisplayResolver,
} from "../src/models-dev/display"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

type TestLanguageModel = ModelCatalogInput["language"][number]

function testModel(provider: string, modelId: string): TestLanguageModel {
  return {
    specificationVersion: "v4",
    provider,
    modelId,
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Not implemented by the test model.")
    },
    async doStream() {
      throw new Error("Not implemented by the test model.")
    },
  } as TestLanguageModel
}

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})

function createApp(
  models?: ModelCatalogInput,
  displayResolver: LanguageModelDisplayResolver = new ModelsDevDisplayResolver({ fetch: null })
) {
  const sixb = new SixbHost<readonly OntologySource[]>({
    id: "model-route-tests",
    ontology: [Invoice],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    models,
  })

  return createSixbApi(
    new SixbServer({ host: sixb, quiet: true, browser: createTestBrowserPolicy() }),
    { modelDisplayResolver: displayResolver }
  )
}

describe("GET /api/models", () => {
  test("lists the configured language models with the default flagged", async () => {
    const app = createApp({
      language: [
        testModel("gateway", "openai/gpt-5.4"),
        testModel("gateway", "anthropic/claude-sonnet-4.6"),
      ],
    })

    const response = await app.fetch(new Request("http://localhost/api/models"))
    expect(response.status).toBe(200)

    expect(await response.json()).toEqual({
      language: [
        {
          provider: "gateway",
          modelId: "openai/gpt-5.4",
          isDefault: true,
          name: "GPT-5.4",
          description: "Agent-ready GPT for coding and computer-use workflows at a lower cost",
          publisher: {
            id: "openai",
            name: "OpenAI",
            logoUrl: "https://models.dev/logos/openai.svg",
          },
          via: "AI Gateway",
          capabilities: {
            input: ["text", "image", "pdf"],
            output: ["text"],
            attachments: true,
            reasoning: true,
            tools: true,
            structuredOutput: true,
            contextWindowTokens: 1_050_000,
          },
          reasoningLevels: ["provider-default", "none", "low", "medium", "high", "xhigh"],
        },
        {
          provider: "gateway",
          modelId: "anthropic/claude-sonnet-4.6",
          isDefault: false,
          name: "Claude Sonnet 4.6",
          description:
            "Claude workhorse for coding agents, careful analysis, and production cost control",
          publisher: {
            id: "anthropic",
            name: "Anthropic",
            logoUrl: "https://models.dev/logos/anthropic.svg",
          },
          via: "AI Gateway",
          capabilities: {
            input: ["text", "image", "pdf"],
            output: ["text"],
            attachments: true,
            reasoning: true,
            tools: true,
            contextWindowTokens: 1_000_000,
          },
          reasoningLevels: ["provider-default", "low", "medium", "high"],
        },
      ],
    })
  })

  test("returns an empty catalog when the project configures no models", async () => {
    const app = createApp(undefined, {
      resolveAll: () => {
        throw new Error("The resolver must not run without configured models.")
      },
    })

    const response = await app.fetch(new Request("http://localhost/api/models"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ language: [] })
  })

  test("keeps custom models usable without inventing display capabilities", async () => {
    const app = createApp({
      language: [testModel("internal-ai", "acme-private-model-9f8b7")],
    })

    const response = await app.fetch(new Request("http://localhost/api/models"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      language: [
        {
          provider: "internal-ai",
          modelId: "acme-private-model-9f8b7",
          isDefault: true,
          name: "Acme Private Model 9f8b7",
          publisher: { id: "internal-ai", name: "Internal AI" },
          capabilities: { input: [], output: [] },
          reasoningLevels: [],
        },
      ],
    })
  })

  test("refreshes display metadata once per TTL and revalidates it with the ETag", async () => {
    let now = 1_000
    const requests: Request[] = []
    const displayResolver = new ModelsDevDisplayResolver({
      now: () => now,
      cacheTtlMs: 100,
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        if (requests.length > 1) {
          return new Response(null, { status: 304 })
        }
        return Response.json(
          {
            "openai/gpt-5.4": {
              name: "Current GPT-5.4",
              description: "Live model metadata",
              attachment: true,
              reasoning: true,
              reasoning_options: [
                { type: "toggle" },
                { type: "effort", values: [null, "low", "high"] },
              ],
              tool_call: true,
              structured_output: true,
              modalities: { input: ["text", "image", "future"], output: ["text"] },
              limit: { context: 900_000 },
            },
          },
          { headers: { etag: '"catalog-v1"' } }
        )
      },
    })
    const model = { provider: "gateway", modelId: "openai/gpt-5.4" }

    const [first, concurrent] = await Promise.all([
      displayResolver.resolveAll([model]),
      displayResolver.resolveAll([model]),
    ])
    expect(first).toMatchObject([
      {
        name: "Current GPT-5.4",
        capabilities: { input: ["text", "image"], contextWindowTokens: 900_000 },
        reasoningLevels: ["provider-default", "none", "low", "high"],
      },
    ])
    expect(concurrent).toEqual(first)
    expect(requests).toHaveLength(1)

    now += 101
    await displayResolver.resolveAll([model])
    expect(requests).toHaveLength(2)
    expect(requests[1]?.headers.get("if-none-match")).toBe('"catalog-v1"')
  })

  test("uses the embedded snapshot and backs off when a refresh fails", async () => {
    let now = 1_000
    let refreshes = 0
    const refreshErrors: unknown[] = []
    const displayResolver = new ModelsDevDisplayResolver({
      now: () => now,
      retryAfterMs: 100,
      fetch: async () => {
        refreshes += 1
        throw new Error("offline")
      },
      onRefreshError: (error) => refreshErrors.push(error),
    })
    const model = { provider: "gateway", modelId: "openai/gpt-5.4" }

    await expect(displayResolver.resolveAll([model])).resolves.toMatchObject([{ name: "GPT-5.4" }])
    await displayResolver.resolveAll([model])
    expect(refreshes).toBe(1)
    expect(refreshErrors).toHaveLength(1)

    now += 101
    await displayResolver.resolveAll([model])
    expect(refreshes).toBe(2)
  })

  test("retains provider-specific reasoning controls absent from the live common catalog", async () => {
    const displayResolver = new ModelsDevDisplayResolver({
      fetch: async () =>
        Response.json({
          "openai/gpt-5.4": {
            name: "Current GPT-5.4",
            reasoning: true,
            modalities: { input: ["text"], output: ["text"] },
          },
        }),
    })

    await expect(
      displayResolver.resolveAll([{ provider: "gateway", modelId: "openai/gpt-5.4" }])
    ).resolves.toMatchObject([
      {
        name: "Current GPT-5.4",
        reasoningLevels: ["provider-default", "none", "low", "medium", "high", "xhigh"],
      },
    ])
  })

  test("accepts a configured model and reasoning level for an Agent turn", async () => {
    const app = createApp({
      language: [
        testModel("gateway", "openai/gpt-5.4"),
        testModel("gateway", "anthropic/claude-sonnet-4.6"),
      ],
    })
    const threadResponse = await app.fetch(
      new Request("http://localhost/api/agent-threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    )
    const { thread } = (await threadResponse.json()) as { thread: { id: string } }

    const response = await app.fetch(
      new Request(`http://localhost/api/agent-threads/${thread.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Review this request.",
          model: { provider: "gateway", modelId: "anthropic/claude-sonnet-4.6" },
          reasoning: "high",
        }),
      })
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      run: {
        model: { provider: "gateway", modelId: "anthropic/claude-sonnet-4.6" },
        reasoning: "high",
      },
    })
  })

  test("rejects a turn model outside the project catalog", async () => {
    const app = createApp({ language: [testModel("gateway", "openai/gpt-5.4")] })
    const threadResponse = await app.fetch(
      new Request("http://localhost/api/agent-threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    )
    const { thread } = (await threadResponse.json()) as { thread: { id: string } }

    const response = await app.fetch(
      new Request(`http://localhost/api/agent-threads/${thread.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Review this request.",
          model: { provider: "gateway", modelId: "unconfigured/model" },
        }),
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error:
        "[Sixb] Language model 'gateway/unconfigured/model' is not in the project model catalog.",
    })
  })
})
