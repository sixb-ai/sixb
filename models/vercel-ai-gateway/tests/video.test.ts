import { expect, test } from "bun:test"
import { InMemoryBlobStorage, InMemoryStorage, SixbHost } from "@sixb/core"
import { InMemoryBroker } from "@sixb/core/broker"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { InMemoryLakeStorage } from "@sixb/core/lake-storage"
import { InMemoryQueues } from "@sixb/core/queues"
import { createVercelGateway } from "../src"

const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

// Shapes and prices from Vercel's live catalog on 2026-11-18.
const catalog = {
  data: [
    {
      id: "google/veo-3.1-fast-generate-001",
      type: "video",
      name: "Veo 3.1 Fast Generate",
      pricing: {
        video_duration_pricing: [
          { resolution: "720p", audio: false, cost_per_second: "0.1" },
          { resolution: "720p", audio: true, cost_per_second: "0.15" },
          { resolution: "4k", audio: true, cost_per_second: "0.35" },
        ],
      },
      video_capabilities: {
        supported_aspect_ratios: ["9:16", "16:9"],
        supported_durations_seconds: [8, 4, 6],
        generate_audio: true,
        max_sample_count: 4,
        input_limits: {
          image: { max_count: 3, max_file_size_mb: 20, supported_formats: ["jpg", "jpeg", "png"] },
        },
      },
    },
    {
      id: "alibaba/wan-v3.0-video",
      type: "video",
      pricing: {
        video_duration_pricing: [
          { resolution: "480p", cost_per_second: "0.05" },
          { resolution: "720p", cost_per_second: "0.1" },
          { cost_per_second: "0.2" },
        ],
      },
      video_capabilities: { supported_durations_seconds: [2, 30] },
    },
    {
      id: "klingai/kling-v2.6-t2v",
      type: "video",
      pricing: {
        video_duration_pricing: [
          { mode: "std", cost_per_second: "0.042" },
          { audio: true, mode: "pro", cost_per_second: "0.14" },
        ],
      },
    },
  ],
}

interface Recorded {
  readonly url: string
  readonly headers: Headers
  readonly body?: Record<string, unknown>
}

function gateway(reply: (url: string, body: Record<string, unknown> | undefined) => Response) {
  const requests: Recorded[] = []
  const provider = createVercelGateway({
    baseUrl: "https://gateway.test/prefix/v1",
    apiKey: "key",
    fetch: async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json(catalog)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ url: String(url), headers: new Headers(init?.headers), body })
      return reply(String(url), body)
    },
  })
  return { provider, requests }
}

const request = { callId: "call_1", prompt: "a fox", n: 1, referenceImages: [] }

// Removal proof: drop the idempotency-key header from start(); a retried start bills twice.
test("a start posts the job to the video endpoint and keeps its operation", async () => {
  const { provider, requests } = gateway(() =>
    Response.json({
      operation: { gatewayJobId: "job_1" },
      warnings: [{ type: "unsupported", feature: "seed" }],
    })
  )
  const model = await provider.video("google/veo-3.1-fast-generate-001").resolve!()

  const started = await model.start({
    ...request,
    durationSeconds: 4,
    resolution: "1280x720",
    aspectRatio: "16:9",
    audio: true,
    seed: 7,
    firstFrame: { url: "https://api.example.test/api/files/downloads/a", mediaType: "image/png" },
    referenceImages: [{ data: PNG, mediaType: "image/png" }],
  })

  expect(requests[0]!.url).toBe("https://gateway.test/prefix/v4/ai/video-model/start")
  expect(requests[0]!.headers.get("ai-model-id")).toBe("google/veo-3.1-fast-generate-001")
  expect(requests[0]!.headers.get("ai-video-model-specification-version")).toBe("4")
  expect(requests[0]!.headers.get("idempotency-key")).toBe("call_1")
  expect(requests[0]!.body).toEqual({
    prompt: "a fox",
    n: 1,
    duration: 4,
    resolution: "1280x720",
    aspectRatio: "16:9",
    generateAudio: true,
    seed: 7,
    image: {
      type: "url",
      url: "https://api.example.test/api/files/downloads/a",
      mediaType: "image/png",
    },
    inputReferences: [{ type: "file", mediaType: "image/png", data: base64(PNG) }],
  })
  expect(started).toEqual({
    operation: { gatewayJobId: "job_1" },
    pricingDimensions: { resolution: "720p", audio: "audio" },
    warnings: ["unsupported: seed"],
  })
})

test("a last frame sends both frames as role-tagged frame images", async () => {
  const { provider, requests } = gateway(() => Response.json({ operation: "op" }))
  const model = await provider.video("google/veo-3.1-fast-generate-001").resolve!()
  const frame = (url: string) => ({ url, mediaType: "image/png" })

  await model.start({
    ...request,
    firstFrame: frame("https://a.test/1"),
    lastFrame: frame("https://a.test/2"),
  })

  expect(requests[0]!.body).toMatchObject({
    frameImages: [
      { image: { type: "url", url: "https://a.test/1" }, frameType: "first_frame" },
      { image: { type: "url", url: "https://a.test/2" }, frameType: "last_frame" },
    ],
  })
  expect(requests[0]!.body).not.toHaveProperty("image")
})

// Removal proof: send the Gateway headers with the download in videoData(); the provider's URL
// receives the API key.
test("a status check downloads hosted results without the Gateway's credentials", async () => {
  const { provider, requests } = gateway((url) => {
    if (url === "https://cdn.test/fox.mp4") return new Response(MP4)
    return Response.json({
      status: "completed",
      videos: [
        { type: "url", url: "https://cdn.test/fox.mp4", mediaType: "video/mp4" },
        { type: "base64", data: base64(MP4), mediaType: "video/mp4" },
      ],
      providerMetadata: { gateway: { cost: "0.4", generationId: "gen_video1" } },
    })
  })
  const model = await provider.video("google/veo-3.1-fast-generate-001").resolve!()

  const status = await model.status({ operation: { gatewayJobId: "job_1" } })

  expect(requests[0]!.url).toBe("https://gateway.test/prefix/v4/ai/video-model/status")
  expect(requests[0]!.body).toEqual({ operation: { gatewayJobId: "job_1" } })
  expect(requests[1]!.url).toBe("https://cdn.test/fox.mp4")
  expect(requests[1]!.headers.get("authorization")).toBeNull()
  expect(status).toMatchObject({
    status: "completed",
    output: {
      videos: [
        { data: MP4, mediaType: "video/mp4" },
        { data: MP4, mediaType: "video/mp4" },
      ],
    },
    reportedCost: { money: { amountNanos: "400000000" } },
  })
})

test("a status check reports a running, failed or cancelled job", async () => {
  const replies = [
    { status: "pending" },
    { status: "error", error: "The prompt was refused." },
    { status: "cancelled" },
  ]
  const { provider } = gateway(() => Response.json(replies.shift()))
  const model = await provider.video("alibaba/wan-v3.0-video").resolve!()
  const check = () => model.status({ operation: "op" })

  expect(await check()).toEqual({ status: "pending" })
  expect(await check()).toMatchObject({ status: "failed", error: "The prompt was refused." })
  expect(await check()).toMatchObject({ status: "failed", error: "The generation was cancelled." })
})

test("a refused start says what the Gateway said", async () => {
  const { provider } = gateway(() =>
    Response.json(
      { error: { message: "Request too large: use hosted URLs for images." } },
      { status: 413 }
    )
  )
  const model = await provider.video("google/veo-3.1-fast-generate-001").resolve!()

  const error = await model.start(request).catch((caught) => caught)

  expect(error).toMatchObject({
    message: "[SixbVercelGateway] Request too large: use hosted URLs for images.",
    status: 413,
  })
})

// Removal proof: return undefined from gatewayVideoPrice for a default entry; Wan's card is gone.
test("the catalog sets each model's options and prices it per second", async () => {
  const { provider } = gateway(() => Response.json({}))
  const veo = await provider.video("google/veo-3.1-fast-generate-001").resolve!()
  const wan = await provider.video("alibaba/wan-v3.0-video").resolve!()
  const kling = await provider.video("klingai/kling-v2.6-t2v").resolve!()

  expect(veo.definition).toMatchObject({
    name: "Veo 3.1 Fast Generate",
    maxVideosPerCall: 4,
    aspectRatios: ["9:16", "16:9"],
    durations: [4, 6, 8],
    audio: true,
    inputImages: { maxCount: 3, maxBytes: 20_971_520, mediaTypes: ["image/jpeg", "image/png"] },
  })
  expect(veo.rateCard).toEqual({
    currency: "USD",
    videoOutputSeconds: {
      variants: [
        { resolution: "720p", audio: "silent", price: "0.1" },
        { resolution: "720p", audio: "audio", price: "0.15" },
        { resolution: "4k", audio: "audio", price: "0.35" },
      ],
    },
  })
  expect(wan.rateCard).toEqual({
    currency: "USD",
    videoOutputSeconds: {
      default: "0.2",
      variants: [
        { resolution: "480p", price: "0.05" },
        { resolution: "720p", price: "0.1" },
      ],
    },
  })
  // A price keyed by a quality mode is not one Sixb can match: the reported cost bills it.
  expect(kling.rateCard).toBeUndefined()
  expect(kling.definition.maxVideosPerCall).toBeUndefined()

  // The request's tier, or the dearest one; without a length, the model's longest.
  const reserve = (
    input: Parameters<NonNullable<NonNullable<typeof veo.costEstimator>["estimateReservation"]>>[0]
  ) => veo.costEstimator?.estimateReservation?.(input)
  expect(
    reserve({
      n: 1,
      durationSeconds: 4,
      resolution: "1280x720",
      audio: false,
      promptTokens: 2,
      inputImages: 0,
    })
  ).toEqual({ currency: "USD", amountNanos: "400000000" })
  expect(reserve({ n: 2, promptTokens: 2, inputImages: 0 })).toEqual({
    currency: "USD",
    amountNanos: "5600000000",
  })
  expect(
    kling.costEstimator?.estimateReservation?.({
      n: 1,
      durationSeconds: 5,
      promptTokens: 2,
      inputImages: 0,
    })
  ).toBeUndefined()
})

// Removal proof: drop pricingDimensions from start(); the call is unpriceable without a tier.
test("generates through Sixb: started, checked, downloaded and rated", async () => {
  const { provider } = gateway((url) =>
    url.endsWith("/start")
      ? Response.json({ operation: { gatewayJobId: "job_1" } })
      : Response.json({
          status: "completed",
          videos: [{ type: "base64", data: base64(MP4), mediaType: "video/mp4" }],
        })
  )
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const host = new SixbHost({
    id: "videos",
    ontology: [],
    storage,
    blobStorage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
    models: { video: [provider.video("google/veo-3.1-fast-generate-001")] },
  })
  const sixb = bindRequestExecution(host, {
    request: new Request("http://localhost/videos"),
    authorization: { type: "disabled" },
  })

  const { callId } = await sixb.models.video.start({
    prompt: "a fox",
    duration: 4,
    resolution: "1280x720",
    audio: true,
  })
  const result = (await sixb.models.video.get(callId))!

  expect(result.status).toBe("completed")
  expect(result.usage).toEqual({ outputVideoMs: 4_000 })
  expect(result.cost).toMatchObject({
    status: "rated",
    money: { amountNanos: "600000000" },
    components: [{ meter: "video.output.milliseconds", variant: "720p · audio" }],
  })
  expect(
    new Uint8Array(
      await new Response(await blobStorage.open(result.files[0]!.blobId)).arrayBuffer()
    )
  ).toEqual(MP4)
})
