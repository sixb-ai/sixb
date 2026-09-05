import { describe, expect, spyOn, test } from "bun:test"
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
  defineLanguageModel,
  type LanguageModel,
  ModelCatalogUnavailableError,
} from "@sixb/core/models"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// The route only serializes catalog metadata, so a minimal owned-contract stub is enough.
function testModel(providerId: string, modelId: string): LanguageModel {
  return {
    providerId,
    modelId,
    definition: defineLanguageModel({ kind: "language", providerId, modelId, capabilities: {} }),
    async stream() {
      throw new Error("Route tests do not run inference.")
    },
  }
}

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})

function createApp(models?: ModelCatalogInput) {
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
    new SixbServer({ host: sixb, quiet: true, browser: createTestBrowserPolicy() })
  )
}

describe("GET /api/models", () => {
  test("resolves provider metadata and keeps configured identities and order", async () => {
    // Removal proof: return only entry.model.definition in the route; the resolved metadata is lost.
    const model = testModel("vercel-ai-gateway", "openai/example")
    let resolutions = 0
    const app = createApp({
      language: [
        {
          ...model,
          resolve: async () => {
            resolutions += 1
            return {
              ...model,
              definition: defineLanguageModel({
                ...model.definition,
                name: "Example",
                description: "Provider-owned description",
                contextWindow: 200_000,
                capabilities: {
                  inputMediaTypes: ["image/png", "application/pdf"],
                  localTools: true,
                  nativeStructuredOutput: true,
                  reasoning: { canDisable: true, efforts: ["low", "high", "max"] },
                },
              }),
            }
          },
        },
        testModel("private", "specialist"),
      ],
    })
    const response = await app.fetch(new Request("http://localhost/api/models"))
    expect(response.status).toBe(200)
    expect(resolutions).toBe(1)
    expect(await response.json()).toEqual({
      language: [
        {
          provider: "vercel-ai-gateway",
          modelId: "openai/example",
          isDefault: true,
          name: "Example",
          description: "Provider-owned description",
          publisher: { id: "openai", name: "OpenAI" },
          via: "AI Gateway",
          capabilities: {
            input: ["text", "image", "pdf"],
            output: ["text"],
            attachments: true,
            tools: true,
            structuredOutput: true,
            reasoning: true,
            contextWindowTokens: 200_000,
          },
          reasoningLevels: ["provider-default", "none", "low", "high", "max"],
        },
        {
          provider: "private",
          modelId: "specialist",
          isDefault: false,
          name: "specialist",
          publisher: { id: "private", name: "private" },
          capabilities: { input: ["text"], output: ["text"] },
          reasoningLevels: [],
        },
      ],
    })
  })

  test("returns an empty catalog without resolving providers", async () => {
    const response = await createApp().fetch(new Request("http://localhost/api/models"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ language: [] })
  })

  test("keeps configured metadata when a provider catalog is unavailable", async () => {
    const model = testModel("private", "specialist")
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const response = await createApp({
        language: [
          {
            ...model,
            resolve: async () => {
              throw new ModelCatalogUnavailableError("offline")
            },
          },
        ],
      }).fetch(new Request("http://localhost/api/models"))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        language: [
          {
            modelId: "specialist",
            capabilities: { input: ["text"], output: ["text"] },
            reasoningLevels: [],
          },
        ],
      })
      expect(warning).toHaveBeenCalledTimes(1)
    } finally {
      warning.mockRestore()
    }
  })

  test("rejects a resolver that changes the configured model identity", async () => {
    const model = testModel("private", "specialist")
    const response = await createApp({
      language: [
        {
          ...model,
          resolve: async () => testModel("private", "another-model"),
        },
      ],
    }).fetch(new Request("http://localhost/api/models"))
    expect(response.status).toBe(500)
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
