import { describe, expect, spyOn, test } from "bun:test"
import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type ModelCatalogInput,
  prop,
  SixbHost,
} from "@sixb/core"
import {
  defineLanguageModel,
  type ImageModel,
  type LanguageModel,
  ModelCatalogUnavailableError,
  type SpeechModel,
  type TranscriptionModel,
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
  const sixb = new SixbHost({
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
  test("serializes resolved metadata, publishers, reasoning, and defaults in configured order", async () => {
    // Removal proofs: return only entry.model.definition in the route (the resolved metadata is
    // lost); derive publisher only from entry.provider (the hosted model loses its author, and a
    // custom provider ID must not change the displayed host); drop "max" from the reasoning-level
    // serialization; drop `defaultReasoning` from serializeLanguageModel.
    const gateway = testModel("vercel-ai-gateway", "openai/example")
    const hosted = testModel("company-foundry", "production")
    let resolutions = 0
    const app = createApp({
      language: [
        {
          ...gateway,
          resolve: async () => {
            resolutions += 1
            return {
              ...gateway,
              definition: defineLanguageModel({
                ...gateway.definition,
                name: "Example",
                description: "Provider-owned description",
                contextWindow: 200_000,
                capabilities: {
                  inputMediaTypes: ["image/png", "application/pdf"],
                  localTools: true,
                  nativeStructuredOutput: true,
                  reasoning: {
                    canDisable: true,
                    efforts: ["low", "medium", "high", "xhigh", "max"],
                  },
                },
              }),
            }
          },
        },
        { ...testModel("private", "specialist"), defaultReasoning: "low" },
        {
          ...hosted,
          resolve: async () => ({
            ...hosted,
            definition: defineLanguageModel({
              ...hosted.definition,
              publisher: { id: "zai", name: "Z.ai" },
              via: "Azure AI Foundry",
            }),
          }),
        },
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
          reasoningLevels: ["provider-default", "none", "low", "medium", "high", "xhigh", "max"],
        },
        {
          provider: "private",
          modelId: "specialist",
          isDefault: false,
          defaultReasoning: "low",
          name: "specialist",
          publisher: { id: "private", name: "private" },
          capabilities: { input: ["text"], output: ["text"] },
          reasoningLevels: [],
        },
        {
          provider: "company-foundry",
          modelId: "production",
          isDefault: false,
          name: "production",
          publisher: { id: "zai", name: "Z.ai" },
          via: "Azure AI Foundry",
          capabilities: { input: ["text"], output: ["text"] },
          reasoningLevels: [],
        },
      ],
      image: [],
      audio: { speech: [], transcription: [] },
    })
  })

  test("returns an empty catalog when no models are configured", async () => {
    const response = await createApp().fetch(new Request("http://localhost/api/models"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      language: [],
      image: [],
      audio: { speech: [], transcription: [] },
    })
  })

  // Removal proof: serialize entry.model instead of the resolved binding; the image model's
  // price and catalog name disappear, because only resolution knows them.
  test("lists every kind with what a caller needs to choose and fill a request", async () => {
    const flux: ImageModel = {
      providerId: "gateway",
      modelId: "bfl/flux",
      definition: {
        kind: "image",
        providerId: "gateway",
        modelId: "bfl/flux",
        inputImages: { maxCount: 4, maxBytes: 10_485_760 },
      },
      resolve: async () => ({
        ...flux,
        definition: { ...flux.definition, name: "FLUX", sizes: ["768x768", "1024x1024"] },
        rateCard: {
          currency: "USD",
          images: { variants: [{ size: "768x768", price: "0.008" }] },
        },
      }),
      async generate() {
        throw new Error("Route tests do not run inference.")
      },
    }
    const voice: SpeechModel = {
      providerId: "gateway",
      modelId: "openai/tts-1",
      defaultVoice: "alloy",
      definition: {
        kind: "speech",
        providerId: "gateway",
        modelId: "openai/tts-1",
        description: "Short notifications",
        outputMediaTypes: ["audio/mpeg"],
      },
      // A card the rate card rules reject is never shown as a price.
      rateCard: { currency: "USD" },
      async speak() {
        throw new Error("Route tests do not run inference.")
      },
    }
    const transcriber: TranscriptionModel = {
      providerId: "gateway",
      modelId: "openai/whisper",
      definition: {
        kind: "transcription",
        providerId: "gateway",
        modelId: "openai/whisper",
        maxInputBytes: 26_214_400,
      },
      rateCard: { currency: "USD", audioInputSeconds: "0.0001" },
      async transcribe() {
        throw new Error("Route tests do not run inference.")
      },
    }
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const response = await createApp({
        image: [flux],
        audio: { speech: [voice], transcription: [transcriber] },
      }).fetch(new Request("http://localhost/api/models"))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        language: [],
        image: [
          {
            provider: "gateway",
            modelId: "bfl/flux",
            isDefault: true,
            name: "FLUX",
            sizes: ["768x768", "1024x1024"],
            inputImages: { maxCount: 4, maxBytes: 10_485_760 },
            rateCard: {
              currency: "USD",
              images: { variants: [{ size: "768x768", price: "0.008" }] },
            },
          },
        ],
        audio: {
          speech: [
            {
              provider: "gateway",
              modelId: "openai/tts-1",
              isDefault: true,
              name: "openai/tts-1",
              description: "Short notifications",
              defaultVoice: "alloy",
              outputMediaTypes: ["audio/mpeg"],
            },
          ],
          transcription: [
            {
              provider: "gateway",
              modelId: "openai/whisper",
              isDefault: true,
              name: "openai/whisper",
              maxInputBytes: 26_214_400,
              rateCard: { currency: "USD", audioInputSeconds: "0.0001" },
            },
          ],
        },
      })
      expect(warning).toHaveBeenCalledTimes(1)
    } finally {
      warning.mockRestore()
    }
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

  // Regression proof: remove "max" from the native reasoning schema; admission returns 422.
  test("accepts max reasoning for an Agent turn", async () => {
    const reasoning = "max"
    const app = createApp({
      language: [
        testModel("gateway", "openai/gpt-5.4"),
        testModel("gateway", "openai/gpt-5.6-luna"),
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
          model: { provider: "gateway", modelId: "openai/gpt-5.6-luna" },
          reasoning,
        }),
      })
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      run: {
        model: { provider: "gateway", modelId: "openai/gpt-5.6-luna" },
        reasoning,
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
      code: "model_not_found",
    })
  })
})
