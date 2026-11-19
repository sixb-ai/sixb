import { randomUUID } from "node:crypto"
import { assertModelAccess } from "../../authorization"
import { createFileDownloadUrl } from "../../blob-storage/download-urls"
import type { BlobStorage, FileRef } from "../../blob-storage/types"
import type { ExecutionContext } from "../../execution"
import type { ReadonlyJsonObject } from "../../json"
import type { SixbRuntimeContext } from "../../runtime/types"
import type { AiModelCallOperationRecord, AiUsageStorage } from "../../storage"
import type { ModelCatalog } from "../catalog"
import { ModelProviderError } from "../errors"
import type { ModelExecutionSession } from "../execution/session"
import { prepareModelInputFile, readModelInputFile } from "../input-file"
import type { ModelMoney } from "../pricing"
import { assertVideoModel } from "./catalog"
import {
  checkVideoOperation,
  isWarnings,
  resolveVideoModel,
  type StoredVideoRequest,
  scheduleVideoCheck,
  storedVideoRequest,
  storedVideoResult,
} from "./check"
import { VideoModelResponseError } from "./errors"
import type {
  VideoGenerateInput,
  VideoGeneration,
  VideoInputImage,
  VideoModel,
  VideoModelStart,
  VideoModelsRuntime,
  VideoReservationInput,
} from "./types"

/** How often `generate()` checks on its job: providers take minutes, and bill per job, not per look. */
const POLL_INTERVAL_MS = 5_000
/** A provider may queue a job before it fetches its input images. */
const INPUT_URL_EXPIRY_MS = 60 * 60_000

interface PreparedImage {
  readonly file: FileRef
  readonly mediaType: string
}

interface PreparedRequest {
  readonly prompt: string
  readonly n: number
  readonly durationSeconds?: number
  readonly resolution?: string
  readonly aspectRatio?: string
  readonly audio?: boolean
  readonly seed?: number
  readonly firstFrame?: PreparedImage
  readonly lastFrame?: PreparedImage
  readonly referenceImages: readonly PreparedImage[]
}

/** What the operation record keeps to price the call once it ends. */
export interface VideoRuntimeDependencies {
  readonly blobs: BlobStorage | undefined
  /** Whether the caller sees what an execution's model calls produced. */
  readonly canReadCallsOf: (executionId: string) => Promise<boolean>
  /** Where the API is reachable from outside, to hand the provider URLs to input images. */
  readonly apiPublicOrigin: () => string | undefined
}

/**
 * Video generation outlives the request that starts it. `start` admits the call, starts the job
 * and keeps the provider's handle in storage; any later `get` checks on the job, and the one that
 * sees it end records the call under the execution attempt that admitted it, then stores the
 * videos. `generate` is both, in one process.
 */
export function createVideoRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  catalog: ModelCatalog | undefined,
  session: ModelExecutionSession,
  dependencies: VideoRuntimeDependencies
): VideoModelsRuntime {
  const projectId = runtime.projectId

  async function start(
    input: VideoGenerateInput
  ): Promise<{ readonly generation: VideoGeneration; readonly model: VideoModel }> {
    assertModelAccess(runtime, execution, "models.video.generate")

    const request = prepareRequest(input)
    const blobs = requireBlobs(dependencies.blobs)
    const operations = requireOperationStorage(runtime.storage.aiUsage)

    const signal = session.signal(input.signal)
    signal.throwIfAborted()

    const binding = selectModel(catalog, input.model)
    assertVideoModel(binding)
    assertRequestSupport(binding, request)

    const accounting = await session.accounting()
    accounting.assertHealthy()

    const model = await resolveVideoModel(binding)
    assertRequestSupport(model, request)

    const images = {
      ...(request.firstFrame
        ? { firstFrame: await inputImage(blobs, request.firstFrame, signal) }
        : {}),
      ...(request.lastFrame
        ? { lastFrame: await inputImage(blobs, request.lastFrame, signal) }
        : {}),
      referenceImages: await Promise.all(
        request.referenceImages.map((image) => inputImage(blobs, image, signal))
      ),
    }
    accounting.assertHealthy()

    const imageCount = countImages(request)
    const promptTokens = Math.ceil(new TextEncoder().encode(request.prompt).byteLength / 4)
    const callId = `call_${randomUUID()}`
    await accounting.admitCall({
      callId,
      providerId: model.providerId,
      modelId: model.modelId,
      modelKind: "video",
      inputTokens:
        imageCount > 0
          ? { status: "unavailable", reason: "nonTextInput" }
          : { status: "estimated", tokens: promptTokens, method: "utf8BytesDividedByFour" },
      outputTokenAllowance: 0,
      reservationCost: estimateReservationCost(model, {
        n: request.n,
        ...optional("durationSeconds", request.durationSeconds),
        ...optional("resolution", request.resolution),
        ...optional("audio", request.audio),
        promptTokens,
        inputImages: imageCount,
      }),
    })

    let started: VideoModelStart
    try {
      signal.throwIfAborted()
      started = await model.start({
        callId,
        prompt: request.prompt,
        n: request.n,
        ...optional("durationSeconds", request.durationSeconds),
        ...optional("resolution", request.resolution),
        ...optional("aspectRatio", request.aspectRatio),
        ...optional("audio", request.audio),
        ...optional("seed", request.seed),
        ...images,
        signal,
      })
      if (!isStart(started)) {
        throw new VideoModelResponseError(
          "[SixbModels] Invalid video start response.",
          model.providerId,
          model.modelId,
          {}
        )
      }
    } catch (error) {
      // Whether the provider began a billable job is unknown, so its budget stays reserved.
      await accounting.markCallUnknown(callId)
      throw error
    }

    // The job runs now, whatever happens to this request: its handle must be kept.
    const stored: StoredVideoRequest = {
      n: request.n,
      ...optional("durationSeconds", request.durationSeconds),
      ...optional("dimensions", started.pricingDimensions),
      warnings: [...(started.warnings ?? [])],
    }
    let record: AiModelCallOperationRecord
    try {
      record = await operations.createModelCallOperation({
        projectId,
        callId,
        executionId: accounting.executionId,
        attempt: accounting.attempt,
        modelKind: "video",
        providerId: model.providerId,
        modelId: model.modelId,
        operation: started.operation,
        request: stored as unknown as ReadonlyJsonObject,
        reserved: accounting.hasReservation(callId),
      })
    } catch (error) {
      await accounting.markCallUnknown(callId)
      throw new Error(
        `[SixbModels] Video generation '${callId}' started, but Sixb could not keep track of it.`,
        { cause: error }
      )
    }

    // Settled from the queue if no one asks again: nothing holds its budget forever.
    try {
      await scheduleVideoCheck(runtime.queues.agents, record)
    } catch (error) {
      console.error(
        `[SixbModels] Could not schedule a check of video generation '${callId}'; it settles when it is next read.`,
        error
      )
    }

    return { generation: await generationFrom(record), model }
  }

  async function check(
    callId: string,
    binding?: VideoModel,
    callerSignal?: AbortSignal
  ): Promise<VideoGeneration | null> {
    if (typeof callId !== "string" || !callId.trim()) {
      throw new TypeError("[SixbModels] A model call ID must be a nonblank string.")
    }

    const operations = requireOperationStorage(runtime.storage.aiUsage)
    const record = await operations.getModelCallOperation({ projectId, callId })
    if (!record || record.modelKind !== "video") return null
    if (!(await dependencies.canReadCallsOf(record.executionId))) return null
    if (record.status !== "pending") return generationFrom(record)

    const checked = await checkVideoOperation(
      {
        projectId,
        storage: { executions: runtime.storage.executions, aiUsage: operations },
        catalog,
        blobs: dependencies.blobs,
        accountingFor: (origin, attempt) => session.accountingFor(origin, attempt),
      },
      record,
      { ...(binding ? { binding } : {}), signal: session.signal(callerSignal) }
    )
    return generationFrom(checked)
  }

  async function generationFrom(record: AiModelCallOperationRecord): Promise<VideoGeneration> {
    const stored = storedVideoRequest(record)
    const base = {
      callId: record.callId,
      model: { providerId: record.providerId, modelId: record.modelId },
      createdAt: record.createdAt,
    }
    if (record.status === "pending") {
      return { ...base, status: "pending", files: [], warnings: [...stored.warnings] }
    }

    const result = storedVideoResult(record)
    const files =
      record.status === "completed"
        ? ((await runtime.storage.aiUsage?.getModelCallFiles({ projectId, callId: record.callId }))
            ?.files ?? [])
        : []
    return {
      ...base,
      status: record.status,
      files,
      warnings: [...result.warnings],
      ...optional("error", record.error),
      usage: result.usage,
      cost: result.cost,
    }
  }

  async function inputImage(
    blobs: BlobStorage,
    image: PreparedImage,
    signal: AbortSignal
  ): Promise<VideoInputImage> {
    // A URL keeps the start request small; a provider cannot reach a loopback origin.
    const origin = dependencies.apiPublicOrigin()
    if (isReachableOrigin(origin) && runtime.storage.fileDownloadGrants) {
      const download = await createFileDownloadUrl(
        {
          projectId,
          storage: runtime.storage,
          blobStorage: blobs,
          executionId: execution.id,
          apiPublicOrigin: origin,
        },
        image.file,
        { expiresInMs: INPUT_URL_EXPIRY_MS }
      )
      return { url: download.url, mediaType: image.mediaType }
    }

    return { data: await readModelInputFile(blobs, image.file, signal), mediaType: image.mediaType }
  }

  return {
    async generate(input) {
      const { generation, model } = await start(input)

      // Past the ceiling a check settles the generation, so the wait ends.
      let current = generation
      while (current.status === "pending") {
        await delay(POLL_INTERVAL_MS, session.signal(input.signal))
        const next = await check(generation.callId, model, input.signal)
        if (!next) {
          throw new Error(`[SixbModels] Video generation '${generation.callId}' disappeared.`)
        }
        current = next
      }

      if (current.status === "failed") {
        throw new ModelProviderError(
          `[SixbModels] Video generation failed: ${current.error}`,
          model.providerId,
          model.modelId
        )
      }
      return {
        files: current.files,
        warnings: current.warnings,
        usage: current.usage ?? {},
        cost: current.cost ?? { status: "unpriceable", reason: "missing-usage" },
        callId: current.callId,
      }
    },

    async start(input) {
      return (await start(input)).generation
    },

    get(callId) {
      return check(callId)
    },
  }
}

/** Validate and snapshot the caller's request before the first await. */
function prepareRequest(input: VideoGenerateInput): PreparedRequest {
  if (typeof input?.prompt !== "string" || !input.prompt.trim()) {
    throw new TypeError("[SixbModels] Video generation requires a nonblank prompt.")
  }

  const n = input.n ?? 1
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new TypeError("[SixbModels] Video count 'n' must be a positive safe integer.")
  }
  if (
    input.duration !== undefined &&
    (!Number.isSafeInteger(input.duration) || input.duration <= 0)
  ) {
    throw new TypeError("[SixbModels] Video duration must be a positive whole number of seconds.")
  }
  if (
    input.resolution !== undefined &&
    (typeof input.resolution !== "string" || !/^[1-9]\d*x[1-9]\d*$/.test(input.resolution))
  ) {
    throw new TypeError("[SixbModels] Video resolution must be a frame size such as '1280x720'.")
  }
  if (
    input.aspectRatio !== undefined &&
    (typeof input.aspectRatio !== "string" || !input.aspectRatio.trim())
  ) {
    throw new TypeError("[SixbModels] Video aspectRatio must be a nonblank string.")
  }
  if (input.audio !== undefined && typeof input.audio !== "boolean") {
    throw new TypeError("[SixbModels] Video audio must be a boolean.")
  }
  if (input.seed !== undefined && !Number.isSafeInteger(input.seed)) {
    throw new TypeError("[SixbModels] Video seed must be a safe integer.")
  }
  if (input.referenceImages !== undefined && !Array.isArray(input.referenceImages)) {
    throw new TypeError("[SixbModels] Reference images must be an array of FileRefs.")
  }

  return {
    prompt: input.prompt,
    n,
    ...optional("durationSeconds", input.duration),
    ...optional("resolution", input.resolution),
    ...optional("aspectRatio", input.aspectRatio),
    ...optional("audio", input.audio),
    ...optional("seed", input.seed),
    ...(input.firstFrame ? { firstFrame: prepareModelInputFile(input.firstFrame, "image") } : {}),
    ...(input.lastFrame ? { lastFrame: prepareModelInputFile(input.lastFrame, "image") } : {}),
    referenceImages: (input.referenceImages ?? []).map((image) =>
      prepareModelInputFile(image, "image")
    ),
  }
}

function selectModel(
  catalog: ModelCatalog | undefined,
  requested: VideoModel | undefined
): VideoModel {
  // A model the caller passes runs as given, listed or not; the catalog supplies the default.
  const selected = requested ?? catalog?.video?.default.model
  if (!selected) {
    throw new Error(
      "[SixbModels] Configure models.video in createSixb() or supply a model to generate()."
    )
  }

  return selected
}

function assertRequestSupport(model: VideoModel, request: PreparedRequest): void {
  const definition = model.definition
  if (definition.maxVideosPerCall !== undefined && request.n > definition.maxVideosPerCall) {
    throw new RangeError(
      `[SixbModels] The selected model returns at most ${definition.maxVideosPerCall} videos per call.`
    )
  }
  for (const [field, list] of [
    ["resolution", definition.resolutions],
    ["aspectRatio", definition.aspectRatios],
  ] as const) {
    const value = request[field]
    if (value !== undefined && list && !list.includes(value)) {
      throw new TypeError(
        `[SixbModels] Video ${field} '${value}' is not supported by the selected model. Use one of: ${list.join(", ")}.`
      )
    }
  }
  const durations = definition.durations
  if (
    request.durationSeconds !== undefined &&
    durations &&
    !durations.includes(request.durationSeconds)
  ) {
    throw new TypeError(
      `[SixbModels] A ${request.durationSeconds}-second video is not supported by the selected model. Use one of: ${durations.join(", ")} seconds.`
    )
  }
  if (request.audio === true && definition.audio === false) {
    throw new TypeError("[SixbModels] The selected model makes videos without sound.")
  }

  const images = [
    ...(request.firstFrame ? [request.firstFrame] : []),
    ...(request.lastFrame ? [request.lastFrame] : []),
    ...request.referenceImages,
  ]
  if (images.length === 0) return

  const accepted = definition.inputImages
  if (!accepted) {
    throw new TypeError("[SixbModels] The selected model does not accept input images.")
  }
  if (images.length > accepted.maxCount) {
    throw new RangeError(
      `[SixbModels] The selected model accepts at most ${accepted.maxCount} input images.`
    )
  }
  for (const image of images) {
    if (image.file.sizeBytes > accepted.maxBytes) {
      throw new RangeError(
        `[SixbModels] Input image exceeds the model's ${accepted.maxBytes}-byte input limit.`
      )
    }
    if (accepted.mediaTypes && !accepted.mediaTypes.includes(image.mediaType)) {
      throw new TypeError(
        `[SixbModels] Image media type '${image.mediaType}' is not supported by the selected model.`
      )
    }
  }
}

function countImages(request: PreparedRequest): number {
  return (request.firstFrame ? 1 : 0) + (request.lastFrame ? 1 : 0) + request.referenceImages.length
}

function estimateReservationCost(
  model: VideoModel,
  input: VideoReservationInput
): ModelMoney | undefined {
  try {
    return model.costEstimator?.estimateReservation?.(input)
  } catch {
    // Optional pricing cannot bypass an enforced budget: admission fails closed without it.
    return undefined
  }
}

function requireBlobs(blobs: BlobStorage | undefined): BlobStorage {
  if (!blobs) throw new Error("[SixbModels] Video generation requires blob storage.")
  return blobs
}

function requireOperationStorage(storage: AiUsageStorage | undefined): AiUsageStorage {
  if (!storage) throw new Error("[SixbModels] Video generation requires storage.aiUsage.")
  return storage
}

/** Whether a provider on the internet can fetch a URL at this origin. */
function isReachableOrigin(origin: string | undefined): origin is string {
  if (!origin) return false

  const host = new URL(origin).hostname
  return !(
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host.startsWith("127.")
  )
}

function isStart(value: unknown): value is VideoModelStart {
  const start = value as Partial<VideoModelStart> | null
  return (
    start !== null &&
    typeof start === "object" &&
    start.operation !== undefined &&
    (start.warnings === undefined || isWarnings(start.warnings))
  )
}

function optional<TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined
): { [K in TKey]?: TValue } {
  return (value === undefined ? {} : { [key]: value }) as { [K in TKey]?: TValue }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}
