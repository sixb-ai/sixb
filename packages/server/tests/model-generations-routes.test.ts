import { describe, expect, test } from "bun:test"
import {
  type AuthorizationContext,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  noopLoggerProvider,
  SixbHost,
} from "@sixb/core"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import {
  defineLanguageModel,
  type ImageModel,
  type LanguageModel,
  ModelProviderError,
  type SpeechModel,
  type TranscriptionModel,
} from "@sixb/core/models"
import { Elysia } from "elysia"
import { registerModelCallRoutes } from "../src/routes/model-calls"
import { registerModelGenerationRoutes } from "../src/routes/model-generations"

const projectId = "model-generations"
const PNG = new Uint8Array([137, 80, 78, 71, 1])
const MP3 = new Uint8Array([255, 243, 196, 196, 1])

const writer: LanguageModel = {
  providerId: "test",
  modelId: "writer",
  definition: defineLanguageModel({
    kind: "language",
    providerId: "test",
    modelId: "writer",
    maxOutputTokens: 1000,
    capabilities: {},
  }),
  async stream() {
    return {
      events: (async function* () {
        yield { type: "stream-start" } as const
        yield { type: "text-start", id: "text" } as const
        yield { type: "text-delta", id: "text", delta: "Shipped." } as const
        yield { type: "text-end", id: "text" } as const
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 4 },
        } as const
      })(),
    }
  },
}

function painter(modelId: string, generate?: ImageModel["generate"]): ImageModel {
  return {
    providerId: "test",
    modelId,
    definition: {
      kind: "image",
      providerId: "test",
      modelId,
      sizes: ["768x768"],
      inputImages: { maxCount: 1, maxBytes: 1024 },
    },
    generate:
      generate ??
      (async () => ({
        output: { images: [{ data: PNG, mediaType: "image/png" }] },
        reportedCost: { money: { currency: "USD", amountNanos: "8000000" } },
      })),
  }
}

const voice: SpeechModel = {
  providerId: "test",
  modelId: "voice",
  defaultVoice: "alloy",
  definition: { kind: "speech", providerId: "test", modelId: "voice" },
  speak: async () => ({
    output: { audio: { data: MP3, mediaType: "audio/mpeg" } },
    usage: { inputCharacters: 12 },
  }),
}

const transcriber: TranscriptionModel = {
  providerId: "test",
  modelId: "ears",
  definition: { kind: "transcription", providerId: "test", modelId: "ears", maxInputBytes: 1024 },
  transcribe: async () => ({ output: { text: "Hello there." }, usage: { audioDurationMs: 1250 } }),
}

async function setup(options: { readonly image?: readonly ImageModel[] } = {}) {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  for (const id of ["granted", "plain"]) {
    await storage.auth.users.create({ projectId, id, email: `${id}@example.test` })
  }
  const host = new SixbHost({
    id: projectId,
    ontology: [] as const,
    storage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage,
    queues: new InMemoryQueues(),
    logger: noopLoggerProvider,
    models: {
      language: [writer],
      image: options.image ?? [painter("painter"), painter("sketcher")],
      audio: { speech: [voice], transcription: [transcriber] },
    },
  })
  const as = (userId: string, granted: boolean) => {
    const context: AuthorizationContext = {
      principal: { type: "user", id: userId },
      groupIds: [],
      roleIds: [],
      grants: { ...emptyGrantIndex(), "run:models": granted },
    }
    const app = new Elysia()
    app.derive(({ request }) => ({
      sixb: bindRequestExecution(host, { request, authorization: { type: "principal", context } }),
    }))
    registerModelGenerationRoutes(app, host)
    registerModelCallRoutes(app, host)
    return async (path: string, body?: unknown) => {
      const response = await app.handle(
        new Request(`http://localhost${path}`, {
          method: body === undefined ? "GET" : "POST",
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        })
      )
      return { status: response.status, response }
    }
  }
  return { blobStorage, granted: as("granted", true), plain: as("plain", false) }
}

describe("model generation routes", () => {
  test("every kind answers with its output, usage and cost", async () => {
    const { blobStorage, granted } = await setup()

    const text = await granted("/api/models/language/generations", { prompt: "Status?" })
    expect(text.status).toBe(200)
    expect(await text.response.json()).toMatchObject({
      model: { provider: "test", modelId: "writer" },
      text: "Shipped.",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 4 },
      cost: { status: "unpriceable" },
    })

    const image = await granted("/api/models/image/generations", {
      prompt: "a fox",
      size: "768x768",
    })
    expect(image.status).toBe(200)
    const generated = await image.response.json()
    expect(generated).toMatchObject({
      model: { provider: "test", modelId: "painter" },
      files: [{ mediaType: "image/png" }],
      warnings: [],
      usage: { outputImages: 1 },
      cost: { status: "reported", money: { currency: "USD", amountNanos: "8000000" } },
    })
    // The caller downloads its result through the call it made.
    const content = await granted(
      `/api/ai/model-calls/${generated.callId}/files/content?path=/files/0`
    )
    expect(new Uint8Array(await content.response.arrayBuffer())).toEqual(PNG)

    const speech = await granted("/api/models/audio/speech", { text: "Hello there." })
    expect(await speech.response.json()).toMatchObject({
      model: { modelId: "voice" },
      files: [{ mediaType: "audio/mpeg" }],
      usage: { inputCharacters: 12 },
    })

    const audio = await blobStorage.put({ body: MP3, mediaType: "audio/mpeg" })
    const transcript = await granted("/api/models/audio/transcriptions", { audio })
    expect(await transcript.response.json()).toMatchObject({
      model: { modelId: "ears" },
      text: "Hello there.",
      usage: { audioDurationMs: 1250 },
    })
  })

  // Removal proof: remove assertModelAccess from the image runtime; the plain user generates.
  test("calling a model takes can.run(project.models)", async () => {
    let calls = 0
    const { plain } = await setup({
      image: [
        painter("painter", async () => {
          calls++
          return { output: { images: [{ data: PNG, mediaType: "image/png" }] } }
        }),
      ],
    })

    const refused = await plain("/api/models/image/generations", { prompt: "a fox" })
    expect(refused.status).toBe(403)
    expect(await refused.response.json()).toEqual({
      error: "[Sixb] Principal 'plain' is not allowed to call the project's models.",
    })
    expect(calls).toBe(0)
  })

  test("a request picks a configured model, or is told what is wrong", async () => {
    const { granted } = await setup({
      image: [
        painter("painter"),
        painter("broken", async () => {
          throw new ModelProviderError("[Test] Upstream timed out.", "test", "broken")
        }),
      ],
    })
    const image = (body: Record<string, unknown>) =>
      granted("/api/models/image/generations", { prompt: "a fox", ...body })

    const chosen = await image({ model: { provider: "test", modelId: "painter" } })
    expect(await chosen.response.json()).toMatchObject({ model: { modelId: "painter" } })

    const unknown = await image({ model: { provider: "test", modelId: "missing" } })
    expect(unknown.status).toBe(400)
    expect(await unknown.response.json()).toEqual({
      error:
        "[SixbServer] No image model 'test/missing' is configured. GET /api/models lists them.",
    })
    // Checked against the model before inference, with the runtime's own message.
    const size = await image({ size: "4096x4096" })
    expect(size.status).toBe(400)
    expect(await size.response.json()).toEqual({
      error:
        "[SixbModels] Image size '4096x4096' is not supported by the selected model. Use one of: 768x768.",
    })
    const failed = await image({ model: { provider: "test", modelId: "broken" } })
    expect(failed.status).toBe(502)
  })
})
