import { afterAll, expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { ModelProviderError, UnsupportedModelFeatureError } from "@sixb/core/models"
import { createTestSixb } from "@sixb/core/testing"
import { type AzureAIFoundryOptions, createAzureAIFoundry } from "../src"

// Opt-in: billable speech calls, at most 9, serial and without retries, each a short sentence of
// about 3 seconds (under USD 0.002). With a transcription deployment, one transcription more.
const env = process.env
const enabled = env.SIXB_FOUNDRY_E2E === "1"
const endpoint = env.AZURE_FOUNDRY_PROJECT_ENDPOINT
const apiKey = env.AZURE_FOUNDRY_API_KEY
const deployment = env.AZURE_FOUNDRY_SPEECH_DEPLOYMENT
const transcriber = env.AZURE_FOUNDRY_TRANSCRIPTION_DEPLOYMENT
const language = env.AZURE_FOUNDRY_FAST_DEPLOYMENT
const live = () => test.skipIf(!enabled || !endpoint || !apiKey || !deployment)

let calls = 0
const report: unknown[] = []

const boundedFetch: NonNullable<AzureAIFoundryOptions["fetch"]> = async (input, init) => {
  if (new URL(String(input)).pathname.endsWith("/audio/speech")) {
    if (++calls > 9) throw new Error("Live test speech allowance exhausted")
  }
  return fetch(input, init)
}

function foundry() {
  return createAzureAIFoundry({ endpoint: endpoint!, apiKey, maxRetries: 0, fetch: boundedFetch })
}

const text = "Your replacement chiller part shipped this morning."

afterAll(() => {
  if (calls) console.info("[FoundrySpeechLive]", JSON.stringify({ calls, report }))
})

live()(
  "speaks through Sixb, stores the audio and records usage and cost; the words come back",
  async () => {
    const provider = foundry()
    const blobStorage = new InMemoryBlobStorage()
    const host = new SixbHost({
      id: "foundry-speech-live",
      ontology: [],
      models: {
        audio: {
          speech: [provider.speech(deployment!, { voice: "coral" })],
          ...(transcriber ? { transcription: [provider.transcription(transcriber)] } : {}),
        },
      },
      storage: new InMemoryStorage(),
      broker: new InMemoryBroker(),
      queues: new InMemoryQueues(),
      blobStorage,
      lakeStorage: new InMemoryLakeStorage(),
    })
    const sixb = createTestSixb(host)

    for (const mediaType of ["audio/mpeg", "audio/wav"]) {
      const started = performance.now()
      const result = await sixb.models.audio.speak({
        text,
        mediaType,
        instructions: "Speak in a calm, friendly tone.",
      })
      const ms = Math.round(performance.now() - started)
      report.push({ mediaType, ms, file: result.file, usage: result.usage, cost: result.cost })

      expect(result.file).toMatchObject({ mediaType })
      expect(result.file.sizeBytes).toBeGreaterThan(10_000)
      expect(result.usage.outputTokens).toBeGreaterThan(0)
      expect(result.cost).toMatchObject({ status: "rated", money: { currency: "USD" } })
      expect(
        await host.storage.aiUsage!.getLatestForExecution({
          projectId: host.id,
          executionId: sixb.execution.id,
        })
      ).toMatchObject({ callId: result.callId, modelKind: "speech", requestedModelId: deployment })

      if (transcriber && mediaType === "audio/wav") {
        const heard = await sixb.models.audio.transcribe({ audio: result.file })
        report.push({ heard: heard.output.text, cost: heard.cost })
        expect(heard.output.text.toLowerCase()).toContain("shipped")
      }
    }
  },
  60_000
)

live()(
  "returns Opus, AAC and FLAC as asked; speed changes the length, not the tokens",
  async () => {
    const model = await foundry().speech(deployment!).resolve()
    for (const mediaType of ["audio/ogg", "audio/aac", "audio/flac"]) {
      const result = await model.speak({
        text,
        mediaType,
        speed: mediaType === "audio/flac" ? 2 : 1,
      })
      report.push({ mediaType, bytes: result.output.audio.data.length, usage: result.usage })
      expect(result.output.audio.mediaType).toBe(mediaType)
      expect(result.output.audio.data.length).toBeGreaterThan(5_000)
    }
  },
  60_000
)

live()(
  "Azure's rejections, the wrong deployment kind and the timeout surface as errors",
  async () => {
    const provider = foundry()
    const model = await provider.speech(deployment!).resolve()

    const voice = await model.speak({ text, voice: "nobody" }).catch((error: unknown) => error)
    expect(voice).toBeInstanceOf(ModelProviderError)
    expect(voice).toMatchObject({ status: 400, code: "invalid_value", retryable: false })
    report.push({ voice: String(voice).slice(0, 120) })

    if (language) {
      const wrong = await provider
        .speech(language)
        .resolve()
        .catch((error: unknown) => error)
      expect(wrong).toBeInstanceOf(UnsupportedModelFeatureError)
    }

    const timed = await provider.speech(deployment!, { timeoutMs: 1 }).resolve()
    const timeout = await timed.speak({ text }).catch((error: unknown) => error)
    expect(timeout).toMatchObject({ name: "TimeoutError" })
  },
  30_000
)
