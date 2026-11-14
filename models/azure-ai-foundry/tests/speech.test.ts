import { describe, expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import {
  ModelProviderError,
  SpeechModelResponseError,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import { createTestSixb } from "@sixb/core/testing"
import { type AzureAIFoundryOptions, createAzureAIFoundry } from "../src"

const endpoint = "https://resource.services.ai.azure.com/api/projects/test"
const speechUrl = "https://resource.services.ai.azure.com/openai/v1/audio/speech"

// The record Azure's project discovery returned for a gpt-4o-mini-tts deployment.
const ttsDeployment = {
  type: "ModelDeployment",
  name: "tts",
  modelName: "gpt-4o-mini-tts",
  modelVersion: "2025-12-15",
  modelPublisher: "OpenAI",
  capabilities: { chat_completion: "false", completion: "false" },
  sku: { name: "GlobalStandard", capacity: 10 },
}
const chatDeployment = {
  type: "ModelDeployment",
  name: "chat",
  modelName: "future-chat",
  modelVersion: "1",
  modelPublisher: "Fixture",
  capabilities: { chat_completion: "true" },
  sku: { name: "GlobalStandard" },
}

// An MPEG frame sync, then payload: what `response_format: "mp3"` streams.
const mp3 = new Uint8Array([0xff, 0xf3, 0xc4, 0xc4, 1, 2, 3, 4, 5, 6])

/** The event stream Azure answers with `stream_format: "sse"`, the audio split across deltas. */
function stream(
  audio: Uint8Array,
  usage: object = { input_tokens: 1_000_000, output_tokens: 1_000_000 }
) {
  const half = Math.ceil(audio.length / 2)
  const events = [
    { type: "speech.audio.delta", audio: Buffer.from(audio.subarray(0, half)).toString("base64") },
    { type: "speech.audio.delta", audio: Buffer.from(audio.subarray(half)).toString("base64") },
    { type: "speech.audio.done", usage: { ...usage, total_tokens: 2_000_000 } },
  ]
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "apim-request-id": "request-1" },
  })
}

type Fetch = NonNullable<AzureAIFoundryOptions["fetch"]>

/** Discovery answers from `deployments`; every other request goes to `inference`. */
function foundry(
  inference: Fetch,
  options: Partial<AzureAIFoundryOptions> & { deployments?: unknown[] } = {}
) {
  const calls: string[] = []
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "secret-key",
    catalog: { fetch: async () => Response.json({ azure: { models: {} } }) },
    ...options,
    fetch: async (url, init) => {
      calls.push(new URL(String(url)).pathname)
      if (new URL(String(url)).pathname.endsWith("/deployments"))
        return Response.json({ value: options.deployments ?? [ttsDeployment, chatDeployment] })
      return inference(url, init)
    },
  })
  return { provider, calls }
}

describe("foundry.speech()", () => {
  test("streams the audio as events from the resource and prices its tokens", async () => {
    let request: { url: string; headers: Headers; body: unknown } | undefined
    const { provider, calls } = foundry(async (url, init) => {
      request = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      }
      return stream(mp3)
    })
    const binding = provider.speech("tts", { voice: "coral" })
    expect(calls).toEqual([])
    expect(binding.defaultVoice).toBe("coral")
    expect(binding.definition).toEqual({
      kind: "speech",
      providerId: "azure-ai-foundry",
      modelId: "tts",
      via: "Azure AI Foundry",
      maxInputCharacters: 4096,
      outputMediaTypes: ["audio/mpeg", "audio/ogg", "audio/aac", "audio/flac", "audio/wav"],
      instructions: true,
    })

    const model = await binding.resolve()
    const result = await model.speak({
      text: "Your order shipped.",
      instructions: "Speak warmly.",
      speed: 1.2,
    })

    expect(request?.url).toBe(speechUrl)
    expect(request?.headers.get("api-key")).toBe("secret-key")
    expect(request?.headers.get("accept")).toBe("text/event-stream")
    expect(request?.body).toEqual({
      model: "tts",
      input: "Your order shipped.",
      voice: "coral",
      response_format: "mp3",
      stream_format: "sse",
      instructions: "Speak warmly.",
      speed: 1.2,
    })
    expect(result).toEqual({
      output: { audio: { data: mp3, mediaType: "audio/mpeg" } },
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        raw: { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000 },
      },
      providerIds: { requestId: "request-1" },
    })
    expect(model.definition.publisher).toEqual({ id: "openai", name: "OpenAI" })
    expect(model.rateCard).toEqual({ currency: "USD", input: "0.6", output: "12" })
    // USD 0.60 per million text tokens plus USD 12 per million audio tokens.
    expect(model.costEstimator?.estimate({ usage: result.usage! })).toMatchObject({
      status: "rated",
      money: { currency: "USD", amountNanos: "12600000000" },
    })
    // The audio's length, so its tokens, is unknown before the call.
    expect(model.costEstimator?.estimateReservation).toBeUndefined()
  })

  test("asks for the format requested, checks the reply is that format, fixes WAV sizes", async () => {
    const formats: unknown[] = []
    // A streamed WAV header: RIFF and data sizes left at 0xFFFFFFFF.
    const wav = new Uint8Array(48)
    wav.set(Buffer.from("RIFF"), 0)
    new DataView(wav.buffer).setUint32(4, 0xffffffff, true)
    wav.set(Buffer.from("WAVEfmt "), 8)
    wav.set(Buffer.from("data"), 36)
    new DataView(wav.buffer).setUint32(40, 0xffffffff, true)
    const replies: Record<string, Uint8Array> = {
      wav,
      opus: new Uint8Array([...Buffer.from("OggS"), 0, 2]),
      flac: new Uint8Array([...Buffer.from("fLaC"), 0, 0]),
      aac: new Uint8Array([0xff, 0xf1, 0x58, 0x40]),
    }
    const { provider } = foundry(async (_, init) => {
      const format = JSON.parse(String(init?.body)).response_format
      formats.push(format)
      return stream(replies[format] ?? mp3)
    })
    const model = await provider.speech("tts").resolve()

    const wave = await model.speak({ text: "Hi", mediaType: "audio/wav" })
    const view = new DataView(wave.output.audio.data.buffer, wave.output.audio.data.byteOffset)
    expect(view.getUint32(4, true)).toBe(40)
    expect(view.getUint32(40, true)).toBe(4)
    for (const mediaType of ["audio/ogg", "audio/flac", "audio/aac"])
      expect((await model.speak({ text: "Hi", mediaType })).output.audio.mediaType).toBe(mediaType)
    expect(formats).toEqual(["wav", "opus", "flac", "aac"])

    // Removal proof: return the audio without hasSignature(); MP3 bytes come back labelled AAC.
    const mislabelled = await foundry(async () => stream(mp3))
      .provider.speech("tts")
      .resolve()
    const error = await mislabelled
      .speak({ text: "Hi", mediaType: "audio/aac" })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SpeechModelResponseError)
    expect(error).toMatchObject({ metadata: { usage: { outputTokens: 1_000_000 } } })

    const raw = await model.speak({ text: "Hi", mediaType: "audio/pcm" }).catch((e: unknown) => e)
    expect(String(raw)).toContain("'audio/pcm' cannot be requested")
  })

  test("a language is not sent, and says so", async () => {
    let body: Record<string, unknown> | undefined
    const { provider } = foundry(async (_, init) => {
      body = JSON.parse(String(init?.body))
      return stream(mp3)
    })
    const result = await (await provider.speech("tts").resolve()).speak({
      text: "Bonjour",
      language: "fr",
    })
    expect(body).not.toHaveProperty("language")
    expect(result.warnings).toEqual([
      "language: not supported; the model reads the text in its own language",
    ])
  })

  test("prices only published versions and SKUs", async () => {
    const usage = { inputTokens: 10, outputTokens: 100 }
    const price = async (deployment: object, rateCard?: object) => {
      const { provider } = foundry(async () => stream(mp3), {
        deployments: [{ ...ttsDeployment, ...deployment }],
      })
      const model = await provider
        .speech("tts", rateCard ? { rateCard: rateCard as never } : {})
        .resolve()
      return model.costEstimator?.estimate({ usage }).status
    }
    expect(await price({})).toBe("rated")
    expect(await price({ modelVersion: "2025-03-20", sku: { name: "Standard" } })).toBe("rated")
    expect(await price({ sku: { name: "DataZoneStandard" } })).toBe("rated")
    expect(await price({ modelVersion: "2026-01-01" })).toBeUndefined()
    expect(await price({ sku: { name: "Standard" } })).toBeUndefined()
    const card = { currency: "USD", input: "1", output: "1" }
    expect(await price({ modelVersion: "2026-01-01" }, card)).toBe("rated")
  })

  test("keeps speech and language deployments apart", async () => {
    const { provider } = foundry(async () => {
      throw new Error("unexpected inference")
    })
    const notSpeech = await provider
      .speech("chat")
      .resolve()
      .catch((error: unknown) => error)
    expect(notSpeech).toBeInstanceOf(UnsupportedModelFeatureError)
    expect(String(notSpeech)).toContain("runs future-chat, not a speech model")
    const asChat = await provider
      .chat("tts")
      .resolve()
      .catch((error: unknown) => error)
    expect(asChat).toBeInstanceOf(UnsupportedModelFeatureError)
    expect(String(asChat)).toContain("Use foundry.speech()")
    expect((await provider.catalog.list()).map((d) => d.modelId)).toEqual(["chat"])

    const connected = foundry(async () => stream(mp3), {
      deployments: [{ ...ttsDeployment, connectionName: "other-resource" }],
    }).provider
    const viaConnection = await connected
      .speech("tts")
      .resolve()
      .catch((e: unknown) => e)
    expect(String(viaConnection)).toContain("project connection")
    const legacy = await foundry(async () => stream(mp3), {
      deployments: [{ ...ttsDeployment, name: "tts-hd", modelName: "tts-hd", modelVersion: "001" }],
    })
      .provider.speech("tts-hd")
      .resolve()
      .catch((e: unknown) => e)
    expect(String(legacy)).toContain("tts-hd is not supported: deploy gpt-4o-mini-tts")
    expect(() => provider.speech(" tts")).toThrow("deploymentName")
    expect(() => provider.speech("tts", { voice: " " })).toThrow("voice")
    expect(() => provider.speech("tts", { timeoutMs: 0 })).toThrow("timeoutMs")
  })
})

describe("speech errors", () => {
  test("a rejection keeps Azure's message and code; throttling is not replayed", async () => {
    // Removal proof: drop "speech" from ONE_SHOT in transport.ts; the 429 is posted thrice.
    let posts = 0
    const { provider } = foundry(
      async () => {
        posts++
        return posts === 1
          ? Response.json(
              {
                error: {
                  message: "Invalid value: 'nope'. Supported values are: 'alloy', 'echo'.",
                  type: "invalid_request_error",
                  code: "invalid_value",
                },
              },
              { status: 400 }
            )
          : new Response(null, { status: 429, headers: { "retry-after-ms": "0" } })
      },
      { maxRetries: 2 }
    )
    const model = await provider.speech("tts").resolve()
    const rejected = await model.speak({ text: "Hi", voice: "nope" }).catch((e: unknown) => e)
    expect(rejected).toBeInstanceOf(ModelProviderError)
    expect(rejected).toMatchObject({ status: 400, code: "invalid_value", retryable: false })
    const throttled = await model.speak({ text: "Hi" }).catch((e: unknown) => e)
    expect(throttled).toMatchObject({ status: 429, retryable: true })
    expect(posts).toBe(2)
  })

  test("a stream cut off before its done event fails, as does one with an error event", async () => {
    // Removal proof: drop the `!done` problem in readSpeechStream(); the clipped audio comes back.
    const delta = `data: ${JSON.stringify({ type: "speech.audio.delta", audio: Buffer.from(mp3).toString("base64") })}\n\n`
    const cut = await foundry(async () => new Response(delta))
      .provider.speech("tts")
      .resolve()
    const clipped = await cut.speak({ text: "Hi" }).catch((e: unknown) => e)
    expect(clipped).toBeInstanceOf(SpeechModelResponseError)
    expect(String(clipped)).toContain("ended before speech.audio.done")

    const failing = await foundry(
      async () =>
        new Response(
          `${delta}data: ${JSON.stringify({ type: "error", error: { message: "The server had an error" } })}\n\n`
        )
    )
      .provider.speech("tts")
      .resolve()
    expect(String(await failing.speak({ text: "Hi" }).catch((e: unknown) => e))).toContain(
      "Speech generation failed: The server had an error"
    )
  })

  test("an event split across data lines, and across network chunks, is read whole", async () => {
    const audio = Buffer.from(mp3).toString("base64")
    const text =
      `data: {"type":"speech.audio.delta",\ndata: "audio":"${audio}"}\n\n` +
      `data: {"type":"speech.audio.done","usage":{"input_tokens":1,"output_tokens":2}}\n\ndata: [DONE]\n\n`
    const bytes = new TextEncoder().encode(text)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7))
        controller.close()
      },
    })
    const model = await foundry(async () => new Response(body))
      .provider.speech("tts")
      .resolve()
    const result = await model.speak({ text: "Hi" })
    expect(result.output.audio.data).toEqual(mp3)
    expect(result.usage).toMatchObject({ inputTokens: 1, outputTokens: 2 })
  })

  test("a stream without audio, or failing midway, keeps the usage it reported", async () => {
    const failing = new Response(
      `data: ${JSON.stringify({ type: "speech.audio.delta", audio: Buffer.from(mp3).toString("base64") })}\n\n` +
        `data: ${JSON.stringify({ type: "error", error: { message: "server_error" } })}\n\n`
    )
    for (const reply of [() => stream(new Uint8Array()), () => failing]) {
      const model = await foundry(async () => reply())
        .provider.speech("tts")
        .resolve()
      const error = await model.speak({ text: "Hi" }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(SpeechModelResponseError)
    }
    const empty = await foundry(async () => stream(new Uint8Array()))
      .provider.speech("tts")
      .resolve()
    expect(await empty.speak({ text: "Hi" }).catch((e: unknown) => e)).toMatchObject({
      metadata: { usage: { inputTokens: 1_000_000 } },
    })
  })

  test("the timeout and the caller's signal both reach the transport", async () => {
    const hang: Fetch = (_, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })
      })
    const { provider } = foundry(hang)
    const timed = await provider.speech("tts", { timeoutMs: 5 }).resolve()
    expect(await timed.speak({ text: "Hi" }).catch((e: unknown) => e)).toMatchObject({
      name: "TimeoutError",
    })
    const controller = new AbortController()
    const model = await provider.speech("tts").resolve()
    const pending = model.speak({ text: "Hi", signal: controller.signal }).catch((e: unknown) => e)
    controller.abort(new Error("cancelled"))
    expect(await pending).toMatchObject({ message: "cancelled" })
  })
})

describe("in a project", () => {
  test("sixb.models.audio.speak() stores the audio and records usage and cost", async () => {
    const { provider } = foundry(async () => stream(mp3))
    const project = new SixbHost({
      id: "foundry-speech",
      ontology: [],
      models: { audio: { speech: [provider.speech("tts")] } },
      storage: new InMemoryStorage(),
      broker: new InMemoryBroker(),
      queues: new InMemoryQueues(),
      blobStorage: new InMemoryBlobStorage(),
      lakeStorage: new InMemoryLakeStorage(),
    })
    const sixb = createTestSixb(project)
    const result = await sixb.models.audio.speak({ text: "Your order shipped." })

    expect(result.file).toMatchObject({ mediaType: "audio/mpeg", sizeBytes: mp3.length })
    expect(result.cost).toMatchObject({ status: "rated", money: { amountNanos: "12600000000" } })
    expect(
      await project.storage.aiUsage!.getLatestForExecution({
        projectId: project.id,
        executionId: sixb.execution.id,
      })
    ).toMatchObject({ callId: result.callId, modelKind: "speech", requestedModelId: "tts" })
  })
})
