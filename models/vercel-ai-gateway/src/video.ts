import {
  assertJsonObject,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type ModelPricingDimensions,
  type ModelProviderError,
  type ModelRateCard,
  type ReadonlyJsonValue,
  type VideoCostEstimator,
  type VideoData,
  type VideoInputImage,
  type VideoModel,
  type VideoModelDefinition,
  type VideoModelRequest,
  type VideoModelResponseMetadata,
  type VideoModelStatus,
} from "@sixb/core/models"
import { readGatewayJson } from "./json-response"

const PROVIDER_ID = "vercel-ai-gateway"
// Starting a job and checking on it are short requests; the generation itself runs on the Gateway.
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_VIDEO_BYTES = 512 * 1024 * 1024
const MAX_REPLY_BYTES = 1024 * 1024
const DEFAULT_INPUT_IMAGES = { maxCount: 1, maxBytes: 20 * 1024 * 1024 }
/** The slowest a clip may download: its deadline grows with its size, at this rate. */
const MIN_DOWNLOAD_BYTES_PER_SECOND = 1024 * 1024

export interface VercelGatewayVideoOptions {
  /** When to pick this model, for people and the agent. Defaults to the catalog's description. */
  readonly description?: string
  /** Passed through to the routed provider, such as `{ vertex: { enhancePrompt: false } }`. */
  readonly providerOptions?: JsonObject
  /**
   * Bounds each start and status request, and a clip's download until its first byte; the rest of
   * the download gets a second per MiB on top. Defaults to 60 seconds.
   */
  readonly timeoutMs?: number
  /** Client memory guard for each downloaded video. Defaults to 512 MiB. */
  readonly maxVideoBytes?: number
  /** Client guard for input images, not a promise of upstream support. Defaults to the catalog's. */
  readonly inputImages?: VideoModelDefinition["inputImages"]
}

/** What the Gateway's catalog says about a video model. */
export interface GatewayVideoResolution {
  readonly name?: string
  readonly description?: string
  readonly estimator?: VideoCostEstimator
  readonly rateCard?: ModelRateCard
  readonly maxVideosPerCall?: number
  readonly aspectRatios?: readonly string[]
  readonly durations?: readonly number[]
  readonly audio?: boolean
  readonly inputImages?: VideoModelDefinition["inputImages"]
}

interface VideoTransport {
  readonly startUrl: string
  readonly statusUrl: string
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  headers(): Readonly<Record<string, string>>
  httpError(response: Response, modelId: string): Promise<ModelProviderError>
  metadata(payload: JsonObject, requestId?: string): VideoModelResponseMetadata
  resolution(): Promise<GatewayVideoResolution>
}

/**
 * A Gateway video model, run as an asynchronous job: `start` returns the job's operation as soon
 * as the Gateway accepts it, and `status` looks at it once. Results are downloaded at once, since
 * the URLs the Gateway hands back expire.
 */
export function createGatewayVideo(
  modelId: string,
  options: VercelGatewayVideoOptions,
  transport: VideoTransport,
  resolution?: GatewayVideoResolution
): VideoModel {
  if (typeof modelId !== "string" || !modelId.trim() || modelId.trim() !== modelId) {
    throw new TypeError("[SixbVercelGateway] Video model id must be a nonempty trimmed string.")
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxVideoBytes = options.maxVideoBytes ?? DEFAULT_MAX_VIDEO_BYTES
  for (const [name, value] of Object.entries({ timeoutMs, maxVideoBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`[SixbVercelGateway] Video ${name} must be a positive safe integer.`)
    }
  }
  if (
    options.description !== undefined &&
    (typeof options.description !== "string" || !options.description.trim())
  ) {
    throw new TypeError("[SixbVercelGateway] Video description must be a nonblank string.")
  }
  const providerOptions =
    options.providerOptions === undefined ? undefined : structuredClone(options.providerOptions)
  if (providerOptions) assertJsonObject(providerOptions, "video providerOptions")
  const description = options.description ?? resolution?.description
  const inputImages = options.inputImages ?? resolution?.inputImages ?? DEFAULT_INPUT_IMAGES

  const definition: VideoModelDefinition = Object.freeze({
    kind: "video",
    providerId: PROVIDER_ID,
    modelId,
    via: "Vercel AI Gateway",
    ...(resolution?.name ? { name: resolution.name } : {}),
    ...(description ? { description } : {}),
    ...(resolution?.maxVideosPerCall === undefined
      ? {}
      : { maxVideosPerCall: resolution.maxVideosPerCall }),
    ...(resolution?.aspectRatios
      ? { aspectRatios: Object.freeze([...resolution.aspectRatios]) }
      : {}),
    ...(resolution?.durations ? { durations: Object.freeze([...resolution.durations]) } : {}),
    ...(resolution?.audio === undefined ? {} : { audio: resolution.audio }),
    inputImages,
  })

  const resolve = async () =>
    createGatewayVideo(
      modelId,
      { ...options, providerOptions },
      transport,
      await transport.resolution()
    )

  /** POST one short request to the Gateway's video protocol and read its JSON reply. */
  async function post(
    url: string,
    body: JsonObject,
    operation: string,
    signal: AbortSignal,
    headers: Readonly<Record<string, string>> = {}
  ): Promise<{ readonly payload: JsonObject; readonly requestId?: string }> {
    const response = await transport.fetch(url, {
      method: "POST",
      signal,
      headers: {
        ...transport.headers(),
        "content-type": "application/json",
        "ai-gateway-protocol-version": "0.0.1",
        "ai-video-model-specification-version": "4",
        "ai-model-id": modelId,
        ...headers,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw await transport.httpError(response, modelId)

    const requestId = response.headers.get("x-request-id") ?? undefined
    const payload = await readGatewayJson(response, {
      modelId,
      operation,
      maxBytes: MAX_REPLY_BYTES,
      signal,
    })
    return { payload, ...(requestId === undefined ? {} : { requestId }) }
  }

  const binding: VideoModel = Object.freeze({
    providerId: PROVIDER_ID,
    modelId,
    definition,
    ...(resolution?.estimator ? { costEstimator: resolution.estimator } : {}),
    ...(resolution?.rateCard ? { rateCard: resolution.rateCard } : {}),
    ...(resolution ? {} : { resolve }),

    async start(request: VideoModelRequest) {
      // Sixb resolves before generating; a caller holding the raw binding still gets the catalog.
      if (!resolution) return (await resolve()).start(request)

      const signal = requestSignal(request.signal, timeoutMs)
      // The Gateway deduplicates a retried start on this key, so a retry never bills twice.
      const { payload } = await post(
        transport.startUrl,
        startBody(request, providerOptions),
        "Video generation start",
        signal,
        { "idempotency-key": request.callId }
      )
      if (payload.operation === undefined) {
        throw new Error("[SixbVercelGateway] Video generation start returned no operation.")
      }

      const warnings = Array.isArray(payload.warnings) ? payload.warnings.flatMap(warning) : []
      const dimensions = videoPricingDimensions(request)
      return {
        operation: payload.operation,
        ...(Object.keys(dimensions).length === 0 ? {} : { pricingDimensions: dimensions }),
        ...(warnings.length === 0 ? {} : { warnings }),
      }
    },

    async status(input: { readonly operation: ReadonlyJsonValue; readonly signal?: AbortSignal }) {
      if (!resolution) return (await resolve()).status(input)

      const { payload, requestId } = await post(
        transport.statusUrl,
        // The Gateway takes back the operation it handed out, as it was.
        { operation: input.operation as JsonValue },
        "Video generation status",
        requestSignal(input.signal, timeoutMs)
      )
      // A clip can take far longer to download than the status request: each has its own bound.
      return statusReply(payload, requestId, transport, {
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs,
        maxVideoBytes,
      })
    },
  })
  return binding
}

/**
 * The price variant a request runs at, as the Gateway's catalog names it: a frame size's
 * resolution tier, by its shorter side, and whether it has sound.
 */
export function videoPricingDimensions(request: {
  readonly resolution?: string
  readonly audio?: boolean
}): ModelPricingDimensions {
  const tier = resolutionTier(request.resolution)
  return {
    ...(tier === undefined ? {} : { resolution: tier }),
    ...(request.audio === undefined ? {} : { audio: request.audio ? "audio" : "silent" }),
  }
}

function resolutionTier(resolution: string | undefined): string | undefined {
  const match = resolution ? /^(\d+)x(\d+)$/.exec(resolution) : null
  if (!match) return undefined

  const shorter = Math.min(Number(match[1]), Number(match[2]))
  if (shorter === 1440) return "2k"
  if (shorter === 2160) return "4k"
  return `${shorter}p`
}

function startBody(
  request: VideoModelRequest,
  providerOptions: JsonObject | undefined
): JsonObject {
  // A first frame alone is image-to-video; with a last frame, both are role-tagged frames.
  const frames = request.lastFrame
    ? [
        ...(request.firstFrame
          ? [{ image: wireImage(request.firstFrame), frameType: "first_frame" }]
          : []),
        { image: wireImage(request.lastFrame), frameType: "last_frame" },
      ]
    : undefined

  return {
    prompt: request.prompt,
    n: request.n,
    ...(request.durationSeconds === undefined ? {} : { duration: request.durationSeconds }),
    ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
    ...(request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio }),
    ...(request.audio === undefined ? {} : { generateAudio: request.audio }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(request.firstFrame && !frames ? { image: wireImage(request.firstFrame) } : {}),
    ...(frames ? { frameImages: frames } : {}),
    ...(request.referenceImages.length === 0
      ? {}
      : { inputReferences: request.referenceImages.map(wireImage) }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  }
}

/** A hosted URL keeps the start request under the Gateway's 300 KiB; bytes go inline. */
function wireImage(image: VideoInputImage): JsonObject {
  return "url" in image
    ? { type: "url", url: image.url, mediaType: image.mediaType }
    : { type: "file", mediaType: image.mediaType, data: Buffer.from(image.data).toString("base64") }
}

interface DownloadLimits {
  readonly signal?: AbortSignal
  readonly timeoutMs: number
  readonly maxVideoBytes: number
}

async function statusReply(
  payload: JsonObject,
  requestId: string | undefined,
  transport: VideoTransport,
  limits: DownloadLimits
): Promise<VideoModelStatus> {
  if (payload.status === "pending") return { status: "pending" }

  const metadata = transport.metadata(payload, requestId)
  if (payload.status === "error" || payload.status === "cancelled") {
    const error =
      payload.status === "cancelled"
        ? "The generation was cancelled."
        : typeof payload.error === "string" && payload.error.trim()
          ? payload.error
          : "The provider failed the generation."
    return { status: "failed", error, ...metadata }
  }
  if (payload.status !== "completed") {
    throw new Error(`[SixbVercelGateway] Unknown video generation status '${payload.status}'.`)
  }

  const entries = Array.isArray(payload.videos) ? payload.videos : []
  const videos: VideoData[] = []
  for (const entry of entries) {
    const video = await videoData(entry, transport, limits)
    // An unreadable entry leaves the reply short; the runtime records it and fails the call.
    if (!video) return { status: "completed", output: { videos: [] }, ...metadata }
    videos.push(video)
  }

  const warnings = Array.isArray(payload.warnings) ? payload.warnings.flatMap(warning) : []
  return {
    status: "completed",
    output: { videos },
    ...(warnings.length === 0 ? {} : { warnings }),
    ...metadata,
  }
}

async function videoData(
  entry: unknown,
  transport: VideoTransport,
  limits: DownloadLimits
): Promise<VideoData | undefined> {
  const maxVideoBytes = limits.maxVideoBytes
  if (!isJsonObject(entry) || typeof entry.mediaType !== "string") return undefined
  const mediaType = entry.mediaType.split(";", 1)[0]!.trim().toLowerCase()
  if (!/^video\/[a-z0-9.+-]+$/.test(mediaType)) return undefined

  if (entry.type === "base64" && typeof entry.data === "string" && entry.data) {
    const data = new Uint8Array(Buffer.from(entry.data, "base64"))
    return data.byteLength > maxVideoBytes ? undefined : { data, mediaType }
  }
  if (entry.type !== "url" || typeof entry.url !== "string" || !URL.canParse(entry.url)) {
    return undefined
  }

  const deadline = downloadDeadline(limits)
  try {
    // A hosted result is the provider's own URL: Gateway credentials never go with it.
    const response = await transport.fetch(entry.url, { signal: deadline.signal })
    const length = Number(response.headers.get("content-length")) || undefined
    if (!response.ok || (length ?? 0) > maxVideoBytes) {
      void response.body?.cancel().catch(() => undefined)
      throw new Error(
        `[SixbVercelGateway] Could not download the generated video (HTTP ${response.status}).`
      )
    }

    deadline.extend(length ?? maxVideoBytes)
    const data = new Uint8Array(await response.arrayBuffer())
    return data.byteLength > 0 && data.byteLength <= maxVideoBytes ? { data, mediaType } : undefined
  } finally {
    deadline.clear()
  }
}

/**
 * A clip's download bound: the request timeout until the response starts, then a second per MiB
 * of the clip on top, its announced length or the most Sixb accepts.
 */
function downloadDeadline(limits: DownloadLimits) {
  const controller = new AbortController()
  const abort = () =>
    controller.abort(
      new DOMException("[SixbVercelGateway] The video download timed out.", "TimeoutError")
    )
  let timer = setTimeout(abort, limits.timeoutMs)

  return {
    signal: limits.signal ? AbortSignal.any([limits.signal, controller.signal]) : controller.signal,
    extend(bytes: number) {
      clearTimeout(timer)
      const transferMs = Math.ceil((bytes / MIN_DOWNLOAD_BYTES_PER_SECOND) * 1_000)
      timer = setTimeout(abort, limits.timeoutMs + transferMs)
    },
    clear() {
      clearTimeout(timer)
    },
  }
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)])
  bounded.throwIfAborted()
  return bounded
}

function warning(value: unknown): string[] {
  if (!isJsonObject(value)) return []
  const parts = [value.type, value.feature ?? value.setting, value.details ?? value.message]
  const text = parts.filter((part) => typeof part === "string" && part).join(": ")
  return text ? [text] : []
}
