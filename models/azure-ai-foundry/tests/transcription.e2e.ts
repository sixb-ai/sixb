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

// Opt-in: billable transcriptions, at most 8, serial and without retries. Each one sends the
// audio file named by AZURE_FOUNDRY_TRANSCRIPTION_AUDIO, a few seconds of English speech in WAV
// that mentions a technician; at Azure's prices each costs well under one US cent.
const env = process.env
const enabled = env.SIXB_FOUNDRY_E2E === "1"
const endpoint = env.AZURE_FOUNDRY_PROJECT_ENDPOINT
const apiKey = env.AZURE_FOUNDRY_API_KEY
const audioPath = env.AZURE_FOUNDRY_TRANSCRIPTION_AUDIO
const deployments = [
  env.AZURE_FOUNDRY_TRANSCRIPTION_DEPLOYMENT,
  env.AZURE_FOUNDRY_DIARIZE_DEPLOYMENT,
  env.AZURE_FOUNDRY_GPT_TRANSCRIBE_DEPLOYMENT,
  env.AZURE_FOUNDRY_WHISPER_DEPLOYMENT,
].filter((name): name is string => Boolean(name))
const language = env.AZURE_FOUNDRY_FAST_DEPLOYMENT
const live = () =>
  test.skipIf(!enabled || !endpoint || !apiKey || !audioPath || deployments.length === 0)

let transcriptions = 0
const report: unknown[] = []

const boundedFetch: NonNullable<AzureAIFoundryOptions["fetch"]> = async (input, init) => {
  if (new URL(String(input)).pathname.endsWith("/audio/transcriptions")) {
    if (++transcriptions > 8) throw new Error("Live test transcription allowance exhausted")
  }
  return fetch(input, init)
}

function foundry() {
  return createAzureAIFoundry({ endpoint: endpoint!, apiKey, maxRetries: 0, fetch: boundedFetch })
}

async function audio() {
  return new Uint8Array(await Bun.file(audioPath!).arrayBuffer())
}

afterAll(() => {
  if (transcriptions)
    console.info("[FoundryTranscriptionLive]", JSON.stringify({ transcriptions, report }))
})

live()(
  "transcribes with each deployment and records usage and cost",
  async () => {
    const provider = foundry()
    const data = await audio()
    for (const deployment of deployments) {
      const host = new SixbHost({
        id: "foundry-transcription-live",
        ontology: [],
        models: {
          // The language hint adds no billed text tokens; the first deployment proves it.
          audio: {
            transcription: [
              provider.transcription(
                deployment,
                deployment === deployments[0] ? { language: "en" } : {}
              ),
            ],
          },
        },
        storage: new InMemoryStorage(),
        broker: new InMemoryBroker(),
        queues: new InMemoryQueues(),
        blobStorage: new InMemoryBlobStorage(),
        lakeStorage: new InMemoryLakeStorage(),
      })
      const sixb = createTestSixb(host)
      const started = performance.now()
      const result = await sixb.models.audio.transcribe({
        audio: { data, mediaType: "audio/wav" },
      })
      const ms = Math.round(performance.now() - started)
      const model = await provider.transcription(deployment).resolve()
      report.push({
        deployment,
        model: model.metadata.modelName,
        ms,
        text: result.output.text,
        usage: result.usage,
        cost: result.cost,
      })

      expect(result.output.text.toLowerCase()).toContain("technician")
      expect(
        result.usage.inputTokens !== undefined || result.usage.audioDurationMs !== undefined
      ).toBe(true)
      // gpt-4o-transcribe-diarize has no retail price; every other model is priced.
      if (!/-diarize$/i.test(model.metadata.modelName!))
        expect(result.cost).toMatchObject({ status: "rated", money: { currency: "USD" } })
      expect(
        await host.storage.aiUsage!.getLatestForExecution({
          projectId: host.id,
          executionId: sixb.execution.id,
        })
      ).toMatchObject({ modelKind: "transcription", requestedModelId: deployment })
    }
  },
  60_000
)

live()(
  "Azure's rejections, the wrong deployment kind and the timeout surface as errors",
  async () => {
    const provider = foundry()
    const model = await provider.transcription(deployments[0]!).resolve()

    // Bytes that decode as no audio format Azure knows.
    const garbage = await model
      .transcribe({ audio: new Uint8Array(4096).fill(7), mediaType: "audio/wav" })
      .catch((error: unknown) => error)
    expect(garbage).toBeInstanceOf(ModelProviderError)
    expect(garbage).toMatchObject({ status: 400, retryable: false })

    if (language) {
      const wrong = await provider
        .transcription(language)
        .resolve()
        .catch((error: unknown) => error)
      expect(wrong).toBeInstanceOf(UnsupportedModelFeatureError)
    }

    const timed = await provider.transcription(deployments[0]!, { timeoutMs: 1 }).resolve()
    const timeout = await timed
      .transcribe({ audio: await audio(), mediaType: "audio/wav" })
      .catch((error: unknown) => error)
    expect(timeout).toMatchObject({ name: "TimeoutError" })
    report.push({ garbage: String(garbage), timeout: String(timeout) })
  },
  30_000
)
