import { describe, expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { createVercelGateway } from "../src"

const credential = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN
// Explicitly opt in: each test makes one billable request, a few cents in all.
const enabled = process.env.SIXB_VERCEL_GATEWAY_MEDIA_E2E === "1" && Boolean(credential)

const imageModel = process.env.SIXB_VERCEL_GATEWAY_IMAGE_E2E_MODEL ?? "bfl/flux-3-image-klein"
const chatImageModel =
  process.env.SIXB_VERCEL_GATEWAY_CHAT_IMAGE_E2E_MODEL ?? "google/gemini-3.1-flash-lite-image"
const speechModel = process.env.SIXB_VERCEL_GATEWAY_SPEECH_E2E_MODEL ?? "openai/tts-1"

function setup() {
  const gateway = createVercelGateway()
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const host = new SixbHost({
    id: "gateway-media",
    ontology: [],
    storage,
    blobStorage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
    models: {
      image: [gateway.image(imageModel), gateway.image(chatImageModel)],
      audio: { speech: [gateway.speech(speechModel, { voice: "alloy" })] },
    },
  })
  const sixb = createTestSixb(host)
  return { gateway, storage, blobStorage, host, sixb }
}

/** The ledger keeps the local estimate beside a reported cost; they must agree. */
async function expectEstimateMatchesBill(
  storage: InMemoryStorage,
  projectId: string,
  callId: string
) {
  const calls = await storage.aiCosts.listModelCalls({
    projectId,
    from: new Date(Date.now() - 600_000),
    to: new Date(Date.now() + 600_000),
  })
  const call = calls.items.find((item) => item.usage.callId === callId)
  expect(call?.cost).toMatchObject({ status: "rated" })
  if (call?.cost?.status !== "rated" || call.cost.estimate?.status !== "rated") {
    throw new Error(`Expected a rated estimate beside the bill, got ${JSON.stringify(call?.cost)}`)
  }
  expect(call.cost.estimate.money).toEqual(call.cost.money)
  return call.cost
}

describe.skipIf(!enabled)("live Gateway media", () => {
  test("generates an image through the image endpoint", async () => {
    const { gateway, storage, blobStorage, host, sixb } = setup()
    const result = await sixb.models.image.generate({
      prompt: "A small green triangle on a white background.",
      size: "768x768",
      model: gateway.image(imageModel),
      signal: AbortSignal.timeout(60_000),
    })

    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.mediaType).toMatch(/^image\//)
    expect((await blobStorage.stat(result.files[0]!.blobId))?.sizeBytes).toBeGreaterThan(0)
    expect(result.usage.outputImages).toBe(1)
    const cost = await expectEstimateMatchesBill(storage, host.id, result.callId)
    console.info("[SixbVercelGateway] Live image verified:", { imageModel, cost })
  }, 70_000)

  test("generates an image with a language model that answers with images", async () => {
    const { gateway, storage, host, sixb } = setup()
    const result = await sixb.models.image.generate({
      prompt: "A small blue square on a white background.",
      aspectRatio: "16:9",
      model: gateway.image(chatImageModel),
      signal: AbortSignal.timeout(60_000),
    })

    expect(result.files).toHaveLength(1)
    expect(result.usage).toMatchObject({ outputImages: 1, imageOutputTokens: expect.any(Number) })
    const cost = await expectEstimateMatchesBill(storage, host.id, result.callId)
    console.info("[SixbVercelGateway] Live chat image verified:", {
      chatImageModel,
      usage: result.usage,
      cost,
    })
  }, 70_000)

  test("speaks text with the binding's default voice", async () => {
    const { storage, host, sixb } = setup()
    const result = await sixb.models.audio.speak({
      text: "Hello there.",
      mediaType: "audio/mpeg",
      signal: AbortSignal.timeout(60_000),
    })

    expect(result.file.mediaType).toBe("audio/mpeg")
    expect(result.usage.inputCharacters).toBe(12)
    const cost = await expectEstimateMatchesBill(storage, host.id, result.callId)
    console.info("[SixbVercelGateway] Live speech verified:", { speechModel, cost })
  }, 70_000)
})
