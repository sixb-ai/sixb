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

// Opt-in: billable image calls, at most 6, serial and without retries. GPT Image runs at low
// quality, 1024x1024 (about USD 0.01 each); a FLUX.1 Kontext image costs USD 0.04.
const env = process.env
const enabled = env.SIXB_FOUNDRY_E2E === "1"
const endpoint = env.AZURE_FOUNDRY_PROJECT_ENDPOINT
const apiKey = env.AZURE_FOUNDRY_API_KEY
const gpt = env.AZURE_FOUNDRY_IMAGE_DEPLOYMENT
const kontext = env.AZURE_FOUNDRY_KONTEXT_DEPLOYMENT
// A model without a text output price, priced from its total output tokens.
const mini = env.AZURE_FOUNDRY_IMAGE_MINI_DEPLOYMENT
const flux2 = env.AZURE_FOUNDRY_FLUX2_DEPLOYMENT
const language = env.AZURE_FOUNDRY_FAST_DEPLOYMENT
const live = (skip = false) => test.skipIf(!enabled || !endpoint || !apiKey || !gpt || skip)

let calls = 0
const report: unknown[] = []

const boundedFetch: NonNullable<AzureAIFoundryOptions["fetch"]> = async (input, init) => {
  if (new URL(String(input)).pathname.includes("/images/")) {
    if (++calls > 6) throw new Error("Live test image allowance exhausted")
  }
  return fetch(input, init)
}

function foundry() {
  return createAzureAIFoundry({ endpoint: endpoint!, apiKey, maxRetries: 0, fetch: boundedFetch })
}

afterAll(() => {
  if (calls) console.info("[FoundryImageLive]", JSON.stringify({ calls, report }))
})

live()(
  "generates through Sixb, stores the images, records usage and cost, then edits one",
  async () => {
    const provider = foundry()
    const blobStorage = new InMemoryBlobStorage()
    const models = [
      provider.image(gpt!),
      ...(kontext ? [provider.image(kontext)] : []),
      ...(mini ? [provider.image(mini)] : []),
    ]
    const host = new SixbHost({
      id: "foundry-image-live",
      ontology: [],
      models: { image: models },
      storage: new InMemoryStorage(),
      broker: new InMemoryBroker(),
      queues: new InMemoryQueues(),
      blobStorage,
      lakeStorage: new InMemoryLakeStorage(),
    })
    const sixb = createTestSixb(host)
    let first: Awaited<ReturnType<typeof sixb.models.image.generate>> | undefined

    for (const model of models) {
      const started = performance.now()
      const result = await sixb.models.image.generate({
        model,
        prompt: "A small red cube on a white table, flat illustration",
        size: "1024x1024",
        ...(model.modelId === kontext ? {} : { quality: "low" }),
      })
      const ms = Math.round(performance.now() - started)
      report.push(
        structuredClone({
          deployment: model.modelId,
          ms,
          files: result.files,
          usage: result.usage,
          cost: result.cost,
          warnings: result.warnings,
        })
      )
      first ??= result

      expect(result.files).toHaveLength(1)
      expect(result.files[0]!.mediaType).toMatch(/^image\/(png|jpeg|webp)$/)
      expect(result.files[0]!.sizeBytes).toBeGreaterThan(10_000)
      expect(result.cost).toMatchObject({ status: "rated", money: { currency: "USD" } })
      expect(
        await host.storage.aiUsage!.getLatestForExecution({
          projectId: host.id,
          executionId: sixb.execution.id,
        })
      ).toMatchObject({
        callId: result.callId,
        modelKind: "image",
        requestedModelId: model.modelId,
      })
    }

    // An edit of the first image: GPT Image bills its image input at a rate no card holds.
    const started = performance.now()
    const edit = await sixb.models.image.generate({
      model: models[0],
      prompt: "Make the cube blue",
      size: "1024x1024",
      quality: "low",
      images: first!.files,
    })
    report.push(
      structuredClone({
        edit: true,
        ms: Math.round(performance.now() - started),
        usage: edit.usage,
        cost: edit.cost,
      })
    )
    expect(edit.files).toHaveLength(1)
    expect(edit.usage.raw).toMatchObject({
      input_tokens_details: { image_tokens: expect.any(Number) },
    })
    expect(edit.cost).toMatchObject({ status: "unpriceable" })
  },
  180_000
)

live()(
  "Azure's rejections, refused models, the wrong deployment kind and the timeout surface as errors",
  async () => {
    const provider = foundry()
    const model = await provider.image(gpt!).resolve()

    // GPT Image takes a few sizes only; Azure rejects the rest before generating.
    const size = await model
      .generate({ prompt: "A red cube", n: 1, size: "999x999", images: [] })
      .catch((error: unknown) => error)
    report.push({ size: String(size) })
    expect(size).toBeInstanceOf(ModelProviderError)
    expect(size).toMatchObject({ status: 400, retryable: false })

    if (flux2) {
      const refused = await provider
        .image(flux2)
        .resolve()
        .catch((error: unknown) => error)
      expect(String(refused)).toContain("is not supported")
    }
    if (language) {
      const wrong = await provider
        .image(language)
        .resolve()
        .catch((error: unknown) => error)
      expect(wrong).toBeInstanceOf(UnsupportedModelFeatureError)
    }

    const timed = await provider.image(gpt!, { timeoutMs: 1 }).resolve()
    const timeout = await timed
      .generate({ prompt: "A red cube", n: 1, images: [] })
      .catch((error: unknown) => error)
    expect(timeout).toMatchObject({ name: "TimeoutError" })
  },
  30_000
)
