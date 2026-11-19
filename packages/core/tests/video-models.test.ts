import { afterEach, describe, expect, jest, test } from "bun:test"
import { SixbHost } from "../src"
import { emptyGrantIndex } from "../src/authorization"
import { bindRequestExecution } from "../src/execution/request"
import {
  createModelCatalog,
  defineModelRateCard,
  rateModelCall,
  type VideoModel,
  type VideoModelStatus,
} from "../src/models"
import { setApiPublicOrigin } from "../src/runtime/public-origin"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])
const PNG = new Uint8Array([137, 80, 78, 71, 1])

const COMPLETED: VideoModelStatus = {
  status: "completed",
  output: { videos: [{ data: MP4, mediaType: "video/mp4" }] },
}

/** A provider whose job answers each status check with the next of `statuses`, then the last. */
function createVideoModel(
  statuses: readonly VideoModelStatus[] = [COMPLETED],
  overrides: Partial<VideoModel> = {},
  definition: Partial<VideoModel["definition"]> = {}
) {
  const calls = { starts: [] as Parameters<VideoModel["start"]>[0][], checks: 0 }
  const model: VideoModel = {
    providerId: "test",
    modelId: "director",
    definition: {
      kind: "video",
      providerId: "test",
      modelId: "director",
      maxVideosPerCall: 2,
      resolutions: ["1280x720", "1920x1080"],
      durations: [4, 8],
      audio: true,
      inputImages: { maxCount: 2, maxBytes: 1024, mediaTypes: ["image/png"] },
      ...definition,
    },
    async start(request) {
      calls.starts.push(request)
      return {
        operation: { job: `job_${calls.starts.length}` },
        pricingDimensions: { resolution: "720p" },
        warnings: ["unsupported: seed"],
      }
    },
    async status() {
      const status = statuses[Math.min(calls.checks, statuses.length - 1)]!
      calls.checks++
      return status
    },
    ...overrides,
  }
  return { model, calls }
}

async function setup(model: VideoModel = createVideoModel().model) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: "videos", ontology: [], ...deps, models: { video: [model] } })
  const request = (authorization: Parameters<typeof bindRequestExecution>[1]["authorization"]) =>
    bindRequestExecution(host, { request: new Request("http://localhost/videos"), authorization })
  const sixb = request({ type: "disabled" })
  const reference = await deps.blobStorage.put({ body: PNG, mediaType: "image/png" })
  return {
    ...deps,
    host,
    sixb,
    request,
    reference,
    identity: { projectId: host.id, executionId: sixb.execution.id },
  }
}

function user(id: string, grants: Partial<ReturnType<typeof emptyGrantIndex>> = {}) {
  return {
    type: "principal" as const,
    context: {
      principal: { type: "user" as const, id },
      groupIds: [],
      roleIds: [],
      grants: { ...emptyGrantIndex(), ...grants },
    },
  }
}

async function createCostLimit(storage: ReturnType<typeof createTestRuntimeDeps>["storage"]) {
  await storage.aiLimits.createPolicy({
    id: "cost",
    projectId: "videos",
    subject: { type: "project" },
    limit: {
      meter: "cost.catalogEstimated",
      amount: { currency: "USD", amountNanos: "10000000000" },
    },
  })
}

async function bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Let pending promises run until the code under test arms its next timer. */
async function untilTimer(): Promise<void> {
  for (let turn = 0; turn < 1_000 && jest.getTimerCount() === 0; turn++) {
    await Promise.resolve()
  }
}

afterEach(() => {
  jest.useRealTimers()
})

describe("video generation", () => {
  // Removal proof: remove assertModelAccess from start() in video/runtime.ts; the call starts.
  test("denies principal-scoped calls before starting a job", async () => {
    const { model, calls } = createVideoModel()
    const { request } = await setup(model)

    await expect(request(user("user")).models.video.start({ prompt: "a fox" })).rejects.toThrow(
      "not allowed to call the project's models"
    )
    expect(calls.starts).toHaveLength(0)
  })

  // Removal proof: drop resumeCall from check(); the reservation stays held after the video ends.
  // Removal proof: drop recordFiles from check(); the starting request cannot read the video.
  test("a later request finishes the call the first one started", async () => {
    const { model, calls } = createVideoModel([{ status: "pending" }, COMPLETED], {
      costEstimator: {
        estimateReservation: () => ({ currency: "USD", amountNanos: "800000000" }),
        estimate: () => ({ status: "unpriceable", reason: "missing-rate-card" }),
      },
    })
    const { sixb, request, storage, blobStorage, identity } = await setup(model)
    await createCostLimit(storage)

    const started = await sixb.models.video.start({ prompt: "a fox", duration: 4 })
    expect(started).toMatchObject({
      status: "pending",
      files: [],
      warnings: ["unsupported: seed"],
      model: { providerId: "test", modelId: "director" },
    })
    expect(calls.starts[0]).toMatchObject({ callId: started.callId, durationSeconds: 4, n: 1 })
    const reserved = async () =>
      (await storage.aiLimits.listPolicyStatuses({ projectId: "videos" }))[0]!.consumption
    expect((await reserved()).reserved).toMatchObject({ amount: { amountNanos: "800000000" } })

    const later = request({ type: "disabled" })
    expect(await later.models.video.get(started.callId)).toMatchObject({ status: "pending" })
    const done = await later.models.video.get(started.callId)

    expect(done).toMatchObject({
      callId: started.callId,
      status: "completed",
      usage: { outputVideoMs: 4000 },
      warnings: ["unsupported: seed"],
    })
    expect(done!.files.map((file) => file.mediaType)).toEqual(["video/mp4"])
    expect(await bytes(await blobStorage.open(done!.files[0]!.blobId))).toEqual(MP4)

    // Recorded under the request that admitted it, which reads the videos back.
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      modelKind: "video",
      callId: started.callId,
      usage: { outputVideoMs: 4000 },
    })
    expect(await sixb.models.calls.files(started.callId)).toMatchObject({ files: done!.files })
    expect((await reserved()).reserved).toMatchObject({ amount: { amountNanos: "0" } })

    // A settled generation answers from storage.
    expect(await later.models.video.get(started.callId)).toEqual(done)
    expect(calls.checks).toBe(2)
  })

  // Removal proof: drop check()'s early return for a settled record; the job is checked again.
  test("a failed job is recorded once and reported with the provider's reason", async () => {
    const { model, calls } = createVideoModel([
      {
        status: "failed",
        error: "The prompt was refused.",
        reportedCost: { money: { currency: "USD", amountNanos: "0" } },
      },
    ])
    const { sixb, storage, identity } = await setup(model)

    const { callId } = await sixb.models.video.start({ prompt: "a fox" })
    const failed = await sixb.models.video.get(callId)

    expect(failed).toMatchObject({
      status: "failed",
      error: "The prompt was refused.",
      files: [],
      usage: { outputVideoMs: 0 },
      cost: { status: "reported" },
    })
    expect(await sixb.models.video.get(callId)).toEqual(failed)
    expect(calls.checks).toBe(1)
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      modelKind: "video",
      usage: { outputVideoMs: 0 },
    })
  })

  // Removal proof: return `true` from createModelCallVisibility; the other user sees the call.
  test("a generation is as visible as the request that started it", async () => {
    const { request, storage, host } = await setup()
    for (const id of ["alice", "bob"]) {
      await storage.auth.users.create({ projectId: host.id, id, email: `${id}@example.test` })
    }
    const alice = request(user("alice", { "run:models": true }))
    const { callId } = await alice.models.video.start({ prompt: "a fox" })

    expect(await request(user("bob", { "run:models": true })).models.video.get(callId)).toBeNull()
    expect(await request(user("alice")).models.video.get(callId)).toMatchObject({
      status: "completed",
    })
    expect(await alice.models.video.get("call_unknown")).toBeNull()
  })

  // Removal proof: drop `dimensions: stored.dimensions` in recordVideos; the card has no default
  // price, so the call becomes unpriceable.
  test("generate waits for the videos and prices them per second at the job's tier", async () => {
    jest.useFakeTimers()
    const rateCard = defineModelRateCard({
      currency: "USD",
      videoOutputSeconds: {
        variants: [
          { resolution: "720p", price: "0.1" },
          { resolution: "1080p", price: "0.2" },
        ],
      },
    })
    const { model } = createVideoModel(
      [
        { status: "pending" },
        {
          status: "completed",
          output: {
            videos: [
              { data: MP4, mediaType: "video/mp4" },
              { data: MP4, mediaType: "video/mp4" },
            ],
          },
        },
      ],
      {
        costEstimator: {
          estimate: ({ usage, dimensions }) => rateModelCall({ usage, rateCard, dimensions }),
        },
      }
    )
    const { sixb } = await setup(model)

    const generating = sixb.models.video.generate({ prompt: "a fox", n: 2, duration: 8 })
    for (let check = 0; check < 2; check++) {
      await untilTimer()
      jest.advanceTimersByTime(5_000)
    }
    const result = await generating

    expect(result.files).toHaveLength(2)
    expect(result.usage).toEqual({ outputVideoMs: 16_000 })
    expect(result.cost).toMatchObject({
      status: "rated",
      money: { amountNanos: "1600000000" },
      components: [{ meter: "video.output.milliseconds", quantity: "16000", variant: "720p" }],
    })
  })

  test("generate throws the provider's reason when the job fails", async () => {
    jest.useFakeTimers()
    const { sixb } = await setup(
      createVideoModel([{ status: "failed", error: "No capacity." }]).model
    )

    const generating = sixb.models.video.generate({ prompt: "a fox" }).catch((error) => error)
    await untilTimer()
    jest.advanceTimersByTime(5_000)

    expect(await generating).toMatchObject({
      message: "[SixbModels] Video generation failed: No capacity.",
    })
  })

  // Removal proof: stop checking isVideoData in check(); the unreadable reply completes.
  test("an unreadable reply is recorded, then failed", async () => {
    const { sixb, storage, identity } = await setup(
      createVideoModel([
        { status: "completed", output: { videos: [{ data: MP4, mediaType: "text/plain" }] } },
      ]).model
    )

    const { callId } = await sixb.models.video.start({ prompt: "a fox", duration: 4 })

    expect(await sixb.models.video.get(callId)).toMatchObject({
      status: "failed",
      error: "The provider returned no readable video.",
      usage: { outputVideoMs: 4000 },
    })
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      usage: { outputVideoMs: 4000 },
    })
  })

  // Removal proof: drop markCallUnknown from start()'s catch; the reservation reads as released.
  test("a start the provider refuses keeps its budget unknown and stores nothing", async () => {
    const { model } = createVideoModel([], {
      async start() {
        throw new Error("upstream down")
      },
      costEstimator: {
        estimateReservation: () => ({ currency: "USD", amountNanos: "500000000" }),
        estimate: () => ({ status: "unpriceable", reason: "missing-rate-card" }),
      },
    })
    const { sixb, storage } = await setup(model)
    await createCostLimit(storage)

    await expect(sixb.models.video.start({ prompt: "a fox" })).rejects.toThrow("upstream down")

    const [status] = await storage.aiLimits.listPolicyStatuses({ projectId: "videos" })
    expect(status!.consumption.unknown).toMatchObject({ amount: { amountNanos: "500000000" } })
  })

  test("rejects requests the model cannot serve before starting a job", async () => {
    const { model, calls } = createVideoModel()
    const { sixb, reference } = await setup(model)
    const jpeg = { ...reference, mediaType: "image/jpeg" }

    for (const [input, message] of [
      [{ prompt: " " }, "nonblank prompt"],
      [{ prompt: "a fox", n: 3 }, "at most 2 videos"],
      [{ prompt: "a fox", duration: 1.5 }, "whole number of seconds"],
      [{ prompt: "a fox", duration: 5 }, "Use one of: 4, 8 seconds."],
      [{ prompt: "a fox", resolution: "720p" }, "frame size such as '1280x720'"],
      [{ prompt: "a fox", resolution: "640x480" }, "Use one of: 1280x720, 1920x1080."],
      [{ prompt: "a fox", firstFrame: jpeg }, "not supported"],
      [{ prompt: "a fox", firstFrame: { ...reference, sizeBytes: 2048 } }, "input limit"],
      [
        { prompt: "a fox", firstFrame: reference, referenceImages: [reference, reference] },
        "at most 2 input images",
      ],
    ] as const) {
      await expect(sixb.models.video.start(input)).rejects.toThrow(message)
    }
    expect(calls.starts).toHaveLength(0)

    const silent = await setup(
      createVideoModel([], {}, { audio: false, inputImages: undefined }).model
    )
    await expect(silent.sixb.models.video.start({ prompt: "a fox", audio: true })).rejects.toThrow(
      "without sound"
    )
    await expect(
      silent.sixb.models.video.start({ prompt: "a fox", firstFrame: silent.reference })
    ).rejects.toThrow("does not accept input images")
  })

  // Removal proof: always read the bytes in inputImage(); the provider receives data, not a URL.
  test("hands the provider a URL to its input images when the API is reachable", async () => {
    const { model, calls } = createVideoModel()
    const { sixb, host, reference } = await setup(model)

    await sixb.models.video.start({ prompt: "a fox", firstFrame: reference })
    expect(calls.starts[0]!.firstFrame).toEqual({ data: PNG, mediaType: "image/png" })

    // A loopback origin is out of a provider's reach.
    setApiPublicOrigin(host, "http://localhost:3000")
    await sixb.models.video.start({ prompt: "a fox", lastFrame: reference })
    expect(calls.starts[1]!.lastFrame).toEqual({ data: PNG, mediaType: "image/png" })

    setApiPublicOrigin(host, "https://api.example.test")
    await sixb.models.video.start({ prompt: "a fox", referenceImages: [reference] })
    const [image] = calls.starts[2]!.referenceImages
    expect(image).toMatchObject({
      url: expect.stringMatching(/^https:\/\/api\.example\.test\/api\/files\/downloads\//),
      mediaType: "image/png",
    })
  })

  test("a generation whose model left the catalog cannot be checked", async () => {
    const { sixb, storage } = await setup()
    const unlisted = createVideoModel([{ status: "pending" }], {}, { modelId: "unlisted" }).model
    const { callId } = await sixb.models.video.start({
      prompt: "a fox",
      model: { ...unlisted, modelId: "unlisted" },
    })

    expect(
      await storage.aiUsage.getModelCallOperation({ projectId: "videos", callId })
    ).toMatchObject({
      modelId: "unlisted",
      status: "pending",
    })
    await expect(sixb.models.video.get(callId)).rejects.toThrow("no longer configured")
  })

  test("validates catalog shape", () => {
    expect(() => createModelCatalog({ video: [] })).toThrow("at least one")
    expect(() =>
      createModelCatalog({ video: [createVideoModel([], {}, { durations: [0] }).model] })
    ).toThrow("durations")
    expect(() =>
      createModelCatalog({ video: [createVideoModel([], {}, { maxVideosPerCall: 0 }).model] })
    ).toThrow("maxVideosPerCall")
  })
})
