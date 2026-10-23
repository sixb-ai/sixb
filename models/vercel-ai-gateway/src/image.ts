import {
  assertJsonObject,
  type ImageCostEstimator,
  type ImageData,
  type ImageModel,
  type ImageModelDefinition,
  type ImageModelRequest,
  ImageModelResponseError,
  type ImageModelResponseMetadata,
  type ImageModelResult,
  isJsonObject,
  type JsonObject,
  type ModelRateCard,
  type ModelUsage,
} from "@sixb/core/models"
import { readGatewayJson } from "./json-response"
import { imageMediaType } from "./media-type"

const PROVIDER_ID = "vercel-ai-gateway"
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const DEFAULT_INPUT_IMAGES = { maxCount: 4, maxBytes: 10 * 1024 * 1024 }

export interface VercelGatewayImageOptions {
  /** When to pick this model, for people and the agent. Defaults to the catalog's description. */
  readonly description?: string
  /** Passed through to the routed provider, such as `{ openai: { background: "transparent" } }`. */
  readonly providerOptions?: JsonObject
  /** Includes consuming the response body. Defaults to 120 seconds. */
  readonly timeoutMs?: number
  /** Client memory guard for the base64 reply. Defaults to 64 MiB. */
  readonly maxResponseBytes?: number
  /** Client guard for reference images, not a promise of upstream support. Defaults to 4 × 10 MiB. */
  readonly inputImages?: ImageModelDefinition["inputImages"]
}

/**
 * How the Gateway serves a model: `image` models through the image endpoint, and language models
 * that answer with images (Gemini image models) through chat completions.
 */
export interface GatewayImageResolution {
  readonly protocol: "image" | "chat"
  readonly name?: string
  readonly description?: string
  readonly estimator?: ImageCostEstimator
  readonly rateCard?: ModelRateCard
  /** The sizes the catalog prices, and so the sizes a request may name. */
  readonly sizes?: readonly string[]
}

interface ImageTransport {
  readonly imageUrl: string
  readonly chatUrl: string
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  headers(): Readonly<Record<string, string>>
  metadata(payload: JsonObject, requestId?: string): ImageModelResponseMetadata
  resolution(): Promise<GatewayImageResolution>
}

export function createGatewayImage(
  modelId: string,
  options: VercelGatewayImageOptions,
  transport: ImageTransport,
  resolution?: GatewayImageResolution
): ImageModel {
  if (typeof modelId !== "string" || !modelId.trim() || modelId.trim() !== modelId) {
    throw new TypeError("[SixbVercelGateway] Image model id must be a nonempty trimmed string.")
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  for (const [name, value] of Object.entries({ timeoutMs, maxResponseBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`[SixbVercelGateway] Image ${name} must be a positive safe integer.`)
    }
  }
  if (
    options.description !== undefined &&
    (typeof options.description !== "string" || !options.description.trim())
  ) {
    throw new TypeError("[SixbVercelGateway] Image description must be a nonblank string.")
  }
  const providerOptions =
    options.providerOptions === undefined ? undefined : structuredClone(options.providerOptions)
  if (providerOptions) assertJsonObject(providerOptions, "image providerOptions")
  const description = options.description ?? resolution?.description

  const definition: ImageModelDefinition = Object.freeze({
    kind: "image",
    providerId: PROVIDER_ID,
    modelId,
    via: "Vercel AI Gateway",
    ...(resolution?.name ? { name: resolution.name } : {}),
    ...(description ? { description } : {}),
    ...(resolution?.sizes ? { sizes: Object.freeze([...resolution.sizes]) } : {}),
    // Chat completions return one image per reply.
    ...(resolution?.protocol === "chat" ? { maxImagesPerCall: 1 } : {}),
    inputImages: options.inputImages ?? DEFAULT_INPUT_IMAGES,
  })

  const resolve = async () =>
    createGatewayImage(
      modelId,
      { ...options, providerOptions },
      transport,
      await transport.resolution()
    )

  const binding: ImageModel = Object.freeze({
    providerId: PROVIDER_ID,
    modelId,
    definition,
    ...(resolution?.estimator ? { costEstimator: resolution.estimator } : {}),
    ...(resolution?.rateCard ? { rateCard: resolution.rateCard } : {}),
    ...(resolution ? {} : { resolve }),

    async generate(request: ImageModelRequest): Promise<ImageModelResult> {
      // Sixb resolves before generating; a caller holding the raw binding still gets the catalog.
      if (!resolution) return (await resolve()).generate(request)

      const signal = AbortSignal.any([
        ...(request.signal ? [request.signal] : []),
        AbortSignal.timeout(timeoutMs),
      ])
      signal.throwIfAborted()

      const call = resolution.protocol === "chat" ? chatRequest : imageRequest
      const { url, body, warnings } = call(modelId, request, providerOptions, transport)
      const response = await transport.fetch(url, {
        method: "POST",
        signal,
        headers: {
          ...transport.headers(),
          "content-type": "application/json",
          ...(resolution.protocol === "image"
            ? {
                "ai-gateway-protocol-version": "0.0.1",
                "ai-image-model-specification-version": "4",
                "ai-model-id": modelId,
              }
            : {}),
        },
        body: JSON.stringify(body),
      })
      const requestId = response.headers.get("x-request-id") ?? undefined
      const payload = await readGatewayJson(response, {
        modelId,
        operation: "Image generation",
        maxBytes: maxResponseBytes,
        signal,
      })

      const reply =
        resolution.protocol === "chat"
          ? chatReply(payload, requestId, transport)
          : imageReply(payload, requestId, transport)
      if (!reply.images) {
        throw new ImageModelResponseError(
          "[SixbVercelGateway] Image generation returned no readable images.",
          PROVIDER_ID,
          modelId,
          reply.metadata
        )
      }
      const allWarnings = [...warnings, ...reply.warnings]
      return {
        ...reply.metadata,
        output: { images: reply.images },
        ...(allWarnings.length === 0 ? {} : { warnings: allWarnings }),
      }
    },
  })
  return binding
}

interface PreparedCall {
  readonly url: string
  readonly body: JsonObject
  readonly warnings: readonly string[]
}

function imageRequest(
  modelId: string,
  request: ImageModelRequest,
  providerOptions: JsonObject | undefined,
  transport: ImageTransport
): PreparedCall {
  // The image protocol has no quality or style; the routed provider reads them from its own options.
  const creator = modelId.split("/", 1)[0]!
  const native = {
    ...(request.quality === undefined ? {} : { quality: request.quality }),
    ...(request.style === undefined ? {} : { style: request.style }),
  }
  const options = withProviderOptions(providerOptions, creator, native)
  return {
    url: transport.imageUrl,
    body: {
      prompt: request.prompt,
      n: request.n,
      ...(request.size === undefined ? {} : { size: request.size }),
      ...(request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      ...(options === undefined ? {} : { providerOptions: options }),
      ...(request.images.length === 0
        ? {}
        : {
            files: request.images.map((image) => ({
              type: "file",
              mediaType: image.mediaType,
              data: Buffer.from(image.data).toString("base64"),
            })),
          }),
    },
    warnings: [],
  }
}

function chatRequest(
  modelId: string,
  request: ImageModelRequest,
  providerOptions: JsonObject | undefined,
  transport: ImageTransport
): PreparedCall {
  const warnings = [
    ...(request.quality === undefined ? [] : ["unsupported: quality"]),
    ...(request.style === undefined ? [] : ["unsupported: style"]),
  ]
  // Gemini reads size and aspect ratio from its image configuration.
  const google = modelId.startsWith("google/")
  const imageConfig = {
    ...(request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio }),
    ...(request.size === undefined ? {} : { imageSize: request.size }),
  }
  if (!google) {
    if (request.size !== undefined) warnings.push("unsupported: size")
    if (request.aspectRatio !== undefined) warnings.push("unsupported: aspectRatio")
  }
  const options = google
    ? withProviderOptions(
        providerOptions,
        "google",
        Object.keys(imageConfig).length === 0 ? {} : { imageConfig }
      )
    : providerOptions

  return {
    url: transport.chatUrl,
    body: {
      model: modelId,
      modalities: ["text", "image"],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: request.prompt },
            ...request.images.map((image) => ({
              type: "image_url",
              image_url: {
                url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`,
              },
            })),
          ],
        },
      ],
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      ...(options === undefined ? {} : { providerOptions: options }),
    },
    warnings,
  }
}

interface Reply {
  readonly images?: readonly ImageData[]
  readonly warnings: readonly string[]
  readonly metadata: ImageModelResponseMetadata
}

function imageReply(payload: JsonObject, requestId: string | undefined, transport: ImageTransport) {
  const usage = isJsonObject(payload.usage) ? payload.usage : undefined
  const metadata = transport.metadata(payload, requestId)
  const reply: Reply = {
    images: images(Array.isArray(payload.images) ? payload.images.map(base64Image) : undefined),
    warnings: Array.isArray(payload.warnings) ? payload.warnings.flatMap(warning) : [],
    metadata: {
      ...metadata,
      usage: {
        ...metadata.usage,
        ...count("inputTokens", usage?.inputTokens),
        ...count("outputTokens", usage?.outputTokens),
      },
    },
  }
  return reply
}

function chatReply(payload: JsonObject, requestId: string | undefined, transport: ImageTransport) {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined
  const message = isJsonObject(choice) && isJsonObject(choice.message) ? choice.message : undefined
  const metadata = transport.metadata(
    {
      ...(typeof payload.id === "string" ? { id: payload.id } : {}),
      ...(isJsonObject(message?.provider_metadata)
        ? { provider_metadata: message.provider_metadata }
        : {}),
    },
    requestId
  )
  const reply: Reply = {
    images: images(
      Array.isArray(message?.images)
        ? message.images.map((image) =>
            dataUrlImage(
              isJsonObject(image) && isJsonObject(image.image_url) ? image.image_url.url : undefined
            )
          )
        : undefined
    ),
    warnings: [],
    metadata: {
      ...metadata,
      ...(typeof payload.model === "string" ? { responseModelId: payload.model } : {}),
      usage: { ...metadata.usage, ...chatUsage(payload, message) },
    },
  }
  return reply
}

/**
 * Chat usage reports image tokens as zero; Google's own usage metadata splits output by modality,
 * which is what a per-image price needs to leave image tokens out of the text charge.
 */
function chatUsage(payload: JsonObject, message: JsonObject | undefined): ModelUsage {
  const usage = isJsonObject(payload.usage) ? payload.usage : undefined
  const input = count("inputTokens", usage?.prompt_tokens)
  const cached = isJsonObject(usage?.prompt_tokens_details)
    ? usage.prompt_tokens_details.cached_tokens
    : undefined
  const reasoning = isJsonObject(usage?.completion_tokens_details)
    ? usage.completion_tokens_details.reasoning_tokens
    : undefined

  const providerMetadata = isJsonObject(message?.provider_metadata)
    ? message.provider_metadata
    : undefined
  const google = [providerMetadata?.vertex, providerMetadata?.google].find(isJsonObject)
  const details = isJsonObject(google?.usageMetadata)
    ? google.usageMetadata.candidatesTokensDetails
    : undefined
  const modality = (name: string) =>
    Array.isArray(details)
      ? details.reduce<number>(
          (sum, entry) =>
            isJsonObject(entry) && entry.modality === name && typeof entry.tokenCount === "number"
              ? sum + entry.tokenCount
              : sum,
          0
        )
      : undefined

  return {
    ...input,
    ...count("outputTokens", usage?.completion_tokens),
    ...(input.inputTokens !== undefined && typeof cached === "number"
      ? {
          ...count("cacheReadInputTokens", cached),
          ...count("uncachedInputTokens", input.inputTokens - cached),
        }
      : {}),
    ...count("reasoningOutputTokens", reasoning),
    ...count("imageOutputTokens", modality("IMAGE")),
    ...count("textOutputTokens", modality("TEXT")),
  }
}

function withProviderOptions(
  options: JsonObject | undefined,
  provider: string,
  values: JsonObject
): JsonObject | undefined {
  if (Object.keys(values).length === 0) return options
  const existing = options?.[provider]
  return {
    ...options,
    [provider]: { ...(isJsonObject(existing) ? existing : {}), ...values },
  }
}

function images(
  values: readonly (ImageData | undefined)[] | undefined
): readonly ImageData[] | undefined {
  return values?.length && values.every((image): image is ImageData => image !== undefined)
    ? values
    : undefined
}

function base64Image(value: unknown): ImageData | undefined {
  if (typeof value !== "string" || !value) return undefined
  const data = new Uint8Array(Buffer.from(value, "base64"))
  const mediaType = imageMediaType(data)
  return mediaType ? { data, mediaType } : undefined
}

function dataUrlImage(value: unknown): ImageData | undefined {
  const match = typeof value === "string" ? /^data:([^;,]+);base64,(.+)$/s.exec(value) : null
  if (!match) return undefined
  const data = new Uint8Array(Buffer.from(match[2]!, "base64"))
  const mediaType = imageMediaType(data) ?? match[1]!.toLowerCase()
  return /^image\/[a-z0-9.+-]+$/.test(mediaType) && data.byteLength > 0
    ? { data, mediaType }
    : undefined
}

function warning(value: unknown): string[] {
  if (!isJsonObject(value)) return []
  const parts = [value.type, value.feature ?? value.setting, value.details ?? value.message]
  const text = parts.filter((part) => typeof part === "string" && part).join(": ")
  return text ? [text] : []
}

function count<TField extends keyof ModelUsage>(
  field: TField,
  value: unknown
): Partial<Record<TField, number>> {
  const result: Partial<Record<TField, number>> = {}
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[field] = value
  return result
}
