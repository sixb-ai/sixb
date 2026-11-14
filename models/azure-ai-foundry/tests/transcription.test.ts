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
  TranscriptionModelResponseError,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import { createTestSixb } from "@sixb/core/testing"
import { type AzureAIFoundryOptions, createAzureAIFoundry } from "../src"

const endpoint = "https://resource.services.ai.azure.com/api/projects/test"
const transcriptionUrl =
  "https://resource.services.ai.azure.com/openai/deployments/transcribe/audio/transcriptions?api-version=2024-10-21"

// The records Azure's project discovery returned for audio deployments: no transcription flag.
const transcribeDeployment = {
  type: "ModelDeployment",
  name: "transcribe",
  modelName: "gpt-4o-mini-transcribe",
  modelVersion: "2025-12-15",
  modelPublisher: "OpenAI",
  capabilities: { chat_completion: "false", completion: "false" },
  sku: { name: "GlobalStandard", capacity: 10 },
}
const whisperDeployment = {
  type: "ModelDeployment",
  name: "whisper",
  modelName: "whisper",
  modelVersion: "001",
  modelPublisher: "OpenAI",
  capabilities: {},
  sku: { name: "Standard", capacity: 1 },
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

// Azure's reply for gpt-4o-mini-transcribe with `response_format=json`.
const tokenReply = {
  text: "The cooling unit on line 3 stopped at 9:15.",
  usage: {
    type: "tokens",
    total_tokens: 1_500_000,
    input_tokens: 1_000_000,
    input_token_details: { text_tokens: 0, audio_tokens: 1_000_000 },
    output_tokens: 500_000,
  },
}

const audio = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69])

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
        return Response.json({
          value: options.deployments ?? [transcribeDeployment, whisperDeployment, chatDeployment],
        })
      return inference(url, init)
    },
  })
  return { provider, calls }
}

describe("foundry.transcription()", () => {
  test("uploads the file to the deployment's audio route and prices its tokens", async () => {
    let request: { url: string; headers: Headers; form: FormData } | undefined
    const { provider, calls } = foundry(async (url, init) => {
      request = {
        url: String(url),
        headers: new Headers(init?.headers),
        form: init?.body as FormData,
      }
      return Response.json(tokenReply, { headers: { "apim-request-id": "request-1" } })
    })
    const binding = provider.transcription("transcribe", { language: "en" })
    expect(calls).toEqual([])
    expect(binding.definition).toMatchObject({
      kind: "transcription",
      providerId: "azure-ai-foundry",
      modelId: "transcribe",
      via: "Azure AI Foundry",
      maxInputBytes: 25 * 1024 * 1024,
    })
    expect(binding.definition.mediaTypes).toContain("audio/webm")

    const model = await binding.resolve()
    const result = await model.transcribe({ audio, mediaType: "audio/wav" })

    expect(request?.url).toBe(transcriptionUrl)
    expect(request?.headers.get("api-key")).toBe("secret-key")
    expect(request?.headers.get("accept")).toBe("application/json")
    // fetch sets the multipart boundary itself.
    expect(request?.headers.has("content-type")).toBe(false)
    const file = request?.form.get("file") as File
    expect(file.name).toBe("audio.wav")
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio)
    expect(request?.form.get("response_format")).toBe("json")
    expect(request?.form.get("language")).toBe("en")
    expect(request?.form.has("chunking_strategy")).toBe(false)
    expect(result).toEqual({
      output: { text: tokenReply.text },
      usage: { inputTokens: 1_000_000, outputTokens: 500_000, raw: tokenReply.usage },
      providerIds: { requestId: "request-1" },
    })
    expect(model.definition.publisher).toEqual({ id: "openai", name: "OpenAI" })
    expect(model.metadata).toMatchObject({
      modelName: "gpt-4o-mini-transcribe",
      sku: "GlobalStandard",
    })
    expect(model.rateCard).toEqual({ currency: "USD", input: "3", output: "5" })
    // USD 3 per million audio tokens plus USD 5 per million text tokens.
    expect(model.costEstimator?.estimate({ usage: result.usage! })).toMatchObject({
      status: "rated",
      money: { currency: "USD", amountNanos: "5500000000" },
    })
    // Neither tokens nor duration can be known before Azure decodes the file.
    expect(model.costEstimator?.estimateReservation).toBeUndefined()
  })

  test("a custom content-type header never replaces the multipart boundary", async () => {
    let contentType: string | null = "unset"
    const { provider } = foundry(
      async (_, init) => {
        contentType = new Headers(init?.headers).get("content-type")
        return Response.json(tokenReply)
      },
      { headers: { "content-type": "application/json" } }
    )
    const model = await provider.transcription("transcribe").resolve()
    await model.transcribe({ audio, mediaType: "audio/wav" })
    expect(contentType).toBeNull()
  })

  test("Whisper asks for the verbose format and is priced by the audio duration", async () => {
    let form: FormData | undefined
    const { provider } = foundry(async (_, init) => {
      form = init?.body as FormData
      return Response.json({ task: "transcribe", duration: 8.22, text: "Hello", segments: [] })
    })
    const model = await provider.transcription("whisper").resolve()
    const result = await model.transcribe({ audio, mediaType: "audio/mpeg" })

    expect(form?.get("response_format")).toBe("verbose_json")
    expect((form?.get("file") as File).name).toBe("audio.mp3")
    expect(result.usage).toEqual({ audioDurationMs: 8220 })
    // USD 0.396 per hour on a Standard deployment.
    expect(model.costEstimator?.estimate({ usage: result.usage! })).toMatchObject({
      status: "rated",
      money: { amountNanos: "904200" },
    })
  })

  test("gpt-transcribe reports whole seconds; the diarizing model asks for chunking", async () => {
    const forms: FormData[] = []
    const { provider } = foundry(
      async (url, init) => {
        forms.push(init?.body as FormData)
        return String(url).includes("/gpt-transcribe/")
          ? Response.json({ text: "Hi", usage: { type: "duration", seconds: 9 } })
          : Response.json(tokenReply)
      },
      {
        deployments: [
          {
            ...transcribeDeployment,
            name: "gpt-transcribe",
            modelName: "gpt-transcribe",
            modelVersion: "2026-07-28",
          },
          { ...transcribeDeployment, name: "diarize", modelName: "gpt-4o-transcribe-diarize" },
        ],
      }
    )
    const seconds = await provider.transcription("gpt-transcribe").resolve()
    // USD 0.27 per hour on a GlobalStandard deployment.
    expect(seconds.rateCard).toEqual({ currency: "USD", audioInputSeconds: "0.000075" })
    expect(seconds.costEstimator?.estimate({ usage: { audioDurationMs: 9000 } })).toMatchObject({
      status: "rated",
      money: { amountNanos: "675000" },
    })
    expect((await seconds.transcribe({ audio, mediaType: "audio/wav" })).usage).toEqual({
      audioDurationMs: 9000,
      raw: { type: "duration", seconds: 9 },
    })
    const diarize = await provider.transcription("diarize").resolve()
    await diarize.transcribe({ audio, mediaType: "audio/webm" })
    expect(forms[1]?.get("chunking_strategy")).toBe("auto")
    expect(forms[1]?.get("response_format")).toBe("json")
    // Azure publishes no retail meter for gpt-4o-transcribe-diarize.
    expect(diarize.rateCard).toBeUndefined()
    expect(diarize.costEstimator).toBeUndefined()
  })

  test("prices only published models, versions and SKUs; a rate card prices the rest", async () => {
    const usage = { inputTokens: 100, outputTokens: 10 }
    const price = async (deployment: object, rateCard?: object) => {
      const { provider } = foundry(async () => Response.json(tokenReply), {
        deployments: [{ ...transcribeDeployment, ...deployment }],
      })
      const model = await provider
        .transcription("transcribe", rateCard ? { rateCard: rateCard as never } : {})
        .resolve()
      return model.costEstimator?.estimate({ usage }).status
    }

    expect(await price({})).toBe("rated")
    expect(await price({ modelVersion: "2025-03-20" })).toBe("rated")
    expect(await price({ sku: { name: "DataZoneStandard" } })).toBe("rated")
    expect(await price({ modelVersion: "2027-01-01" })).toBeUndefined()
    expect(await price({ sku: { name: "ProvisionedManaged" } })).toBeUndefined()
    const card = { currency: "USD", input: "1", output: "1" }
    expect(await price({ modelVersion: "2027-01-01" }, card)).toBe("rated")

    // Text input tokens come from a prompt, billed at another rate the card does not hold.
    const model = await foundry(async () => Response.json(tokenReply))
      .provider.transcription("transcribe")
      .resolve()
    const prompted = {
      ...usage,
      raw: { input_token_details: { text_tokens: 5, audio_tokens: 95 } },
    }
    expect(model.costEstimator?.estimate({ usage: prompted }).status).toBe("unpriceable")
    expect(() =>
      foundry(async () => Response.json(tokenReply)).provider.transcription("transcribe", {
        rateCard: card as never,
        costEstimator: { estimate: () => ({ status: "unpriceable", reason: "missing-rate-card" }) },
      })
    ).toThrow("either rateCard or costEstimator")
  })

  test("keeps transcription and language deployments apart", async () => {
    const { provider } = foundry(async () => {
      throw new Error("unexpected inference")
    })
    const notTranscription = await provider
      .transcription("chat")
      .resolve()
      .catch((error: unknown) => error)
    expect(notTranscription).toBeInstanceOf(UnsupportedModelFeatureError)
    expect(String(notTranscription)).toContain(
      "runs future-chat, not a transcription model. Use foundry() or foundry.chat()."
    )
    const asChat = await provider
      .chat("transcribe")
      .resolve()
      .catch((error: unknown) => error)
    expect(asChat).toBeInstanceOf(UnsupportedModelFeatureError)
    expect(String(asChat)).toContain("Use foundry.transcription()")
    const listed = (await provider.catalog.list()).map((d) => d.modelId)
    expect(listed).toContain("chat")
    expect(listed).not.toContain("transcribe")
    expect(listed).not.toContain("whisper")

    const connected = foundry(async () => Response.json(tokenReply), {
      deployments: [{ ...transcribeDeployment, connectionName: "other-resource" }],
    }).provider
    const viaConnection = await connected
      .transcription("transcribe")
      .resolve()
      .catch((e: unknown) => e)
    expect(String(viaConnection)).toContain("project connection")
    expect(() => provider.transcription(" transcribe")).toThrow("deploymentName")
    expect(() => provider.transcription("transcribe", { timeoutMs: 0 })).toThrow("timeoutMs")
    expect(() => provider.transcription("transcribe", { language: "English" })).toThrow("ISO-639")
  })

  test("an unresolved binding resolves once on its first direct call", async () => {
    let posts = 0
    const { provider, calls } = foundry(async () => {
      posts++
      return Response.json(tokenReply)
    })
    const binding = provider.transcription("transcribe")
    await binding.transcribe({ audio, mediaType: "audio/wav" })
    await binding.transcribe({ audio, mediaType: "audio/wav" })
    expect(posts).toBe(2)
    expect(calls.filter((path) => path.endsWith("/deployments"))).toHaveLength(1)
  })
})

describe("transcription errors", () => {
  test("unsupported audio fails before any request", async () => {
    const { provider, calls } = foundry(async () => Response.json(tokenReply))
    const model = provider.transcription("transcribe")
    const aiff = await model.transcribe({ audio, mediaType: "audio/aiff" }).catch((e: unknown) => e)
    expect(String(aiff)).toContain("'audio/aiff' is not supported")
    const empty = await model
      .transcribe({ audio: new Uint8Array(), mediaType: "audio/wav" })
      .catch((e: unknown) => e)
    expect(String(empty)).toContain("1 byte to 25 MiB")
    expect(calls).toEqual([])
  })

  test("a rejection keeps Azure's message and code; throttling is not replayed", async () => {
    // Removal proof: drop "transcription" from ONE_SHOT in transport.ts; the 429 is posted thrice.
    let posts = 0
    const { provider } = foundry(
      async () => {
        posts++
        return posts === 1
          ? Response.json(
              {
                error: {
                  message: "Unsupported file format",
                  type: "invalid_request_error",
                  code: "unsupported_value",
                },
              },
              { status: 400 }
            )
          : new Response(null, { status: 429, headers: { "retry-after-ms": "0" } })
      },
      { maxRetries: 2 }
    )
    const model = await provider.transcription("transcribe").resolve()
    const rejected = await model
      .transcribe({ audio, mediaType: "audio/wav" })
      .catch((e: unknown) => e)
    expect(rejected).toBeInstanceOf(ModelProviderError)
    expect(rejected).toMatchObject({ status: 400, code: "unsupported_value", retryable: false })
    expect(String(rejected)).toContain("Unsupported file format")

    const throttled = await model
      .transcribe({ audio, mediaType: "audio/wav" })
      .catch((e: unknown) => e)
    expect(throttled).toMatchObject({ status: 429, retryable: true, retryAfterMs: 0 })
    expect(posts).toBe(2)
  })

  test("invalid JSON is a provider error; a reply without text keeps its usage", async () => {
    const invalid = await foundry(async () => new Response("{"))
      .provider.transcription("transcribe")
      .resolve()
    expect(
      await invalid.transcribe({ audio, mediaType: "audio/wav" }).catch((e: unknown) => e)
    ).toMatchObject({ code: "invalid_json" })

    const textless = await foundry(async () => Response.json({ usage: tokenReply.usage }))
      .provider.transcription("transcribe")
      .resolve()
    const error = await textless
      .transcribe({ audio, mediaType: "audio/wav" })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TranscriptionModelResponseError)
    expect(error).toMatchObject({ metadata: { usage: { inputTokens: 1_000_000 } } })
  })

  test("the timeout and the caller's signal both reach the transport", async () => {
    const hang: Fetch = (_, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })
      })
    const { provider } = foundry(hang)
    const timed = await provider.transcription("transcribe", { timeoutMs: 5 }).resolve()
    const timeout = await timed
      .transcribe({ audio, mediaType: "audio/wav" })
      .catch((e: unknown) => e)
    expect(timeout).toMatchObject({ name: "TimeoutError" })

    const controller = new AbortController()
    const model = await provider.transcription("transcribe").resolve()
    const pending = model
      .transcribe({ audio, mediaType: "audio/wav", signal: controller.signal })
      .catch((e: unknown) => e)
    controller.abort(new Error("cancelled"))
    expect(await pending).toMatchObject({ message: "cancelled" })
  })
})

describe("in a project", () => {
  test("sixb.models.audio.transcribe() runs it and records usage and cost", async () => {
    const { provider } = foundry(async () => Response.json(tokenReply))
    const project = new SixbHost({
      id: "foundry-transcription",
      ontology: [],
      models: { audio: { transcription: [provider.transcription("transcribe")] } },
      storage: new InMemoryStorage(),
      broker: new InMemoryBroker(),
      queues: new InMemoryQueues(),
      blobStorage: new InMemoryBlobStorage(),
      lakeStorage: new InMemoryLakeStorage(),
    })
    const sixb = createTestSixb(project)
    const result = await sixb.models.audio.transcribe({
      audio: { data: audio, mediaType: "audio/wav" },
    })

    expect(result.output.text).toBe(tokenReply.text)
    expect(result.cost).toMatchObject({ status: "rated", money: { amountNanos: "5500000000" } })
    expect(
      await project.storage.aiUsage!.getLatestForExecution({
        projectId: project.id,
        executionId: sixb.execution.id,
      })
    ).toMatchObject({
      callId: result.callId,
      modelKind: "transcription",
      requestedModelId: "transcribe",
    })
  })
})
