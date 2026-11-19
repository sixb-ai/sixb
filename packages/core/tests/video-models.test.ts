import { afterEach, describe, expect, jest, mock, setSystemTime, spyOn, test } from "bun:test"
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
import { runScheduledVideoCheck, VIDEO_GENERATION_CEILING_MS } from "../src/models/video/check"
import { setApiPublicOrigin } from "../src/runtime/public-origin"
import { InMemoryAiUsageStorage } from "../src/storage"
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
  setSystemTime()
  mock.restore()
})

/** The scheduled check the agent worker would run next, claimed once it is due. */
async function dueCheck(deps: ReturnType<typeof createTestRuntimeDeps>) {
  const [claimed] = await deps.queues.agents.claim({ projectId: "videos", workerId: "test" })
  return claimed
}

/** What a fresh process, sharing only durable storage and queues, checks a generation with. */
function restartedHost(deps: ReturnType<typeof createTestRuntimeDeps>, model: VideoModel) {
  return {
    projectId: "videos",
    storage: deps.storage,
    queues: deps.queues,
    catalog: createModelCatalog({ video: [model] }),
    blobs: deps.blobStorage,
  }
}

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

  // Removal proof: drop abandonVideoOperation from start()'s catch; the reservation reads as
  // still held and the generation stays pending.
  test("a start the provider refuses is failed, its budget unknown", async () => {
    let callId = ""
    const { model } = createVideoModel([], {
      async start(request) {
        callId = request.callId
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

    expect(await sixb.models.video.get(callId)).toMatchObject({
      status: "failed",
      error: "The video could not be started.",
    })
    const [status] = await storage.aiLimits.listPolicyStatuses({ projectId: "videos" })
    expect(status!.consumption).toMatchObject({
      reserved: { amount: { amountNanos: "0" } },
      unknown: { amount: { amountNanos: "500000000" } },
    })
  })

  // Removal proof: queue the check after model.start() in start(), catching its failure; the
  // provider starts a job nothing will check on.
  test("a start whose check cannot be queued fails before the provider sees it", async () => {
    const { model, calls } = createVideoModel()
    const deps = await setup(model)
    spyOn(deps.queues.agents, "enqueue").mockRejectedValueOnce(new Error("queue down"))

    await expect(deps.sixb.models.video.start({ prompt: "a fox" })).rejects.toThrow("queue down")
    expect(calls.starts).toHaveLength(0)
  })

  // Removal proof: drop the check of a missing handle in checkVideoOperation; the provider is
  // asked about an operation it never handed out.
  test("a job whose handle was lost settles at the ceiling, its budget unknown", async () => {
    const { model, calls } = createVideoModel([{ status: "pending" }], {
      costEstimator: {
        estimateReservation: () => ({ currency: "USD", amountNanos: "800000000" }),
        estimate: () => ({ status: "unpriceable", reason: "missing-rate-card" }),
      },
    })
    const deps = await setup(model)
    await createCostLimit(deps.storage)
    const startedAt = new Date("2026-11-18T10:00:00.000Z")
    setSystemTime(startedAt)
    // Storage hands out a proxy of its AI usage store, so the store's own method is replaced.
    spyOn(InMemoryAiUsageStorage.prototype, "startModelCallOperation").mockRejectedValueOnce(
      new Error("storage down")
    )

    const lost = await deps.sixb.models.video.start({ prompt: "a fox" }).catch((error) => error)
    expect(lost).toMatchObject({ message: expect.stringContaining("could not keep track") })
    const callId = calls.starts[0]!.callId
    const check = () =>
      runScheduledVideoCheck(restartedHost(deps, model), callId, AbortSignal.timeout(5_000))

    setSystemTime(new Date(startedAt.getTime() + 60_000))
    await check()
    expect(calls.checks).toBe(0)
    expect(await deps.sixb.models.video.get(callId)).toMatchObject({ status: "pending" })

    setSystemTime(new Date(startedAt.getTime() + VIDEO_GENERATION_CEILING_MS))
    await check()
    expect(await deps.sixb.models.video.get(callId)).toMatchObject({ status: "failed" })
    const [status] = await deps.storage.aiLimits.listPolicyStatuses({ projectId: "videos" })
    expect(status!.consumption.unknown).toMatchObject({ amount: { amountNanos: "800000000" } })
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

  // Removal proof: return the requested model as given from selectModel(); the unlisted model
  // starts a job no later check can find.
  test("only a listed model starts, since later checks find it in the catalog", async () => {
    const { model } = createVideoModel([{ status: "pending" }])
    const deps = await setup(model)
    const unlisted = createVideoModel([], { modelId: "unlisted" }, { modelId: "unlisted" })

    const refused = await deps.sixb.models.video
      .start({ prompt: "a fox", model: unlisted.model })
      .catch((error) => error)
    expect(refused).toMatchObject({ message: expect.stringContaining("not in models.video") })
    expect(unlisted.calls.starts).toHaveLength(0)

    // A model removed from the catalog since is reported, not guessed.
    const { callId } = await deps.sixb.models.video.start({ prompt: "a fox" })
    const other = createVideoModel([], { modelId: "other" }, { modelId: "other" }).model
    const check = runScheduledVideoCheck(
      restartedHost(deps, other),
      callId,
      AbortSignal.timeout(5_000)
    )
    expect(await check.catch((error) => error)).toMatchObject({
      message: expect.stringContaining("no longer configured"),
    })
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

  // Removal proof: drop scheduleVideoCheck from start(); no check is queued and nothing settles.
  test("a generation nobody reads again settles from the queue, even after a restart", async () => {
    const { model, calls } = createVideoModel([{ status: "pending" }, COMPLETED], {
      costEstimator: {
        estimateReservation: () => ({ currency: "USD", amountNanos: "800000000" }),
        estimate: () => ({ status: "unpriceable", reason: "missing-rate-card" }),
      },
    })
    const deps = await setup(model)
    await createCostLimit(deps.storage)
    const startedAt = new Date("2026-11-18T10:00:00.000Z")
    setSystemTime(startedAt)

    const { callId } = await deps.sixb.models.video.start({ prompt: "a fox", duration: 4 })
    expect(await dueCheck(deps)).toBeUndefined()

    // The first look is a minute later, from another process: the job is still running.
    setSystemTime(new Date(startedAt.getTime() + 60_000))
    const first = await dueCheck(deps)
    expect(first?.job).toMatchObject({
      type: "agent.model-call.check.requested",
      payload: { callId },
    })
    await runScheduledVideoCheck(restartedHost(deps, model), callId, AbortSignal.timeout(5_000))
    await deps.queues.agents.complete({
      projectId: "videos",
      jobId: first!.job.id,
      leaseId: first!.leaseId,
    })

    // Removal proof: skip the rescheduling in runScheduledVideoCheck; no second look comes.
    setSystemTime(new Date(startedAt.getTime() + 120_000))
    const second = await dueCheck(deps)
    expect(second?.job.payload).toEqual({ callId })
    await runScheduledVideoCheck(restartedHost(deps, model), callId, AbortSignal.timeout(5_000))

    expect(calls.checks).toBe(2)
    expect(await deps.sixb.models.video.get(callId)).toMatchObject({
      status: "completed",
      files: [{ mediaType: "video/mp4" }],
    })
    const [status] = await deps.storage.aiLimits.listPolicyStatuses({ projectId: "videos" })
    expect(status!.consumption.reserved).toMatchObject({ amount: { amountNanos: "0" } })
  })

  // Removal proof: drop the ceiling from checkVideoOperation; the job stays pending and reserved.
  test("past the ceiling, a job still running fails and its budget becomes unknown", async () => {
    const { model } = createVideoModel([{ status: "pending" }], {
      costEstimator: {
        estimateReservation: () => ({ currency: "USD", amountNanos: "800000000" }),
        estimate: () => ({ status: "unpriceable", reason: "missing-rate-card" }),
      },
    })
    const deps = await setup(model)
    await createCostLimit(deps.storage)
    const startedAt = new Date("2026-11-18T10:00:00.000Z")
    setSystemTime(startedAt)
    const { callId } = await deps.sixb.models.video.start({ prompt: "a fox" })

    setSystemTime(new Date(startedAt.getTime() + VIDEO_GENERATION_CEILING_MS - 1))
    expect(await deps.sixb.models.video.get(callId)).toMatchObject({ status: "pending" })

    setSystemTime(new Date(startedAt.getTime() + VIDEO_GENERATION_CEILING_MS))
    await runScheduledVideoCheck(restartedHost(deps, model), callId, AbortSignal.timeout(5_000))

    expect(await deps.sixb.models.video.get(callId)).toMatchObject({
      status: "failed",
      error: "The provider did not finish the video within 60 minutes.",
      cost: { status: "unpriceable" },
    })
    const [status] = await deps.storage.aiLimits.listPolicyStatuses({ projectId: "videos" })
    expect(status!.consumption).toMatchObject({
      reserved: { amount: { amountNanos: "0" } },
      unknown: { amount: { amountNanos: "800000000" } },
    })
  })

  // Removal proof: drop `recordModelCallOperationResult` from checkVideoOperation, or the
  // `record.result` branch from expire(), or the `pastCeiling` branch around storing the videos;
  // past the ceiling the check throws, marking a reconciled budget unknown or storing again.
  test("a recorded call whose videos cannot be stored settles at the ceiling as billed", async () => {
    const reachable: VideoModel["status"] = async () => ({
      ...COMPLETED,
      reportedCost: { money: { currency: "USD", amountNanos: "400000000" } },
    })
    const unreachable: VideoModel["status"] = async () => {
      throw new Error("Gateway unreachable")
    }
    for (const later of [reachable, unreachable]) {
      let checks = 0
      const { model } = createVideoModel([], {
        status: (input) => (checks++ === 0 ? reachable(input) : later(input)),
        costEstimator: {
          estimateReservation: () => ({ currency: "USD", amountNanos: "800000000" }),
          estimate: () => ({ status: "unpriceable", reason: "missing-rate-card" }),
        },
      })
      const deps = await setup(model)
      await createCostLimit(deps.storage)
      spyOn(deps.blobStorage, "put").mockRejectedValue(new Error("blob storage down"))
      const startedAt = new Date("2026-11-18T10:00:00.000Z")
      setSystemTime(startedAt)
      const { callId } = await deps.sixb.models.video.start({ prompt: "a fox", duration: 4 })
      const check = () =>
        runScheduledVideoCheck(restartedHost(deps, model), callId, AbortSignal.timeout(5_000))

      // The call is in the ledger and its budget reconciled; only its videos are missing.
      expect(await check().catch((error) => error)).toMatchObject({ message: "blob storage down" })
      const consumption = async () =>
        (await deps.storage.aiLimits.listPolicyStatuses({ projectId: "videos" }))[0]!.consumption
      expect((await consumption()).reserved).toMatchObject({ amount: { amountNanos: "0" } })

      setSystemTime(new Date(startedAt.getTime() + VIDEO_GENERATION_CEILING_MS))
      await check()
      expect(await deps.sixb.models.video.get(callId)).toMatchObject({
        status: "failed",
        error: "The provider made the video, but Sixb could not store it.",
        files: [],
        usage: { outputVideoMs: 4000 },
      })
      expect((await consumption()).unknown).toMatchObject({ amount: { amountNanos: "0" } })
      mock.restore()
    }
  })

  // Removal proof: validate the status after checkVideoOperation's try; an invalid reply is
  // retried forever instead of settling.
  test("past the ceiling, a job Sixb can no longer ask about fails too", async () => {
    for (const [status, message] of [
      [
        async () => {
          throw new Error("Gateway unreachable")
        },
        "Gateway unreachable",
      ],
      [async () => ({ status: "running" }) as never, "Invalid video status response"],
    ] as const) {
      const { model } = createVideoModel([], { status })
      const deps = await setup(model)
      const startedAt = new Date("2026-11-18T10:00:00.000Z")
      setSystemTime(startedAt)
      const { callId } = await deps.sixb.models.video.start({ prompt: "a fox" })
      const check = () =>
        runScheduledVideoCheck(restartedHost(deps, model), callId, AbortSignal.timeout(5_000))

      // Before it, the worker retries the job.
      expect(await check().catch((error) => error)).toMatchObject({
        message: expect.stringContaining(message),
      })

      setSystemTime(new Date(startedAt.getTime() + VIDEO_GENERATION_CEILING_MS))
      await check()
      expect(await deps.sixb.models.video.get(callId)).toMatchObject({ status: "failed" })
    }
  })
})
