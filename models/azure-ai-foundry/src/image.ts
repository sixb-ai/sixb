import {
  defineModelRateCard,
  estimateModelReservation,
  type ImageCostEstimator,
  type ImageData,
  type ImageModel,
  type ImageModelDefinition,
  type ImageModelRequest,
  ImageModelResponseError,
  type ImageModelResponseMetadata,
  type ImageModelResult,
  type JsonObject,
  type ModelRateCard,
  type ModelUsage,
  rateModelCall,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import {
  type AzureAIFoundryDeployment,
  deploymentMetadata,
  type FoundryDeployments,
  type ResolvedDeployment,
} from "./discovery"
import { assertDeploymentKind } from "./kinds"
import type { AzureAIFoundryModelMetadata } from "./provider"
import { azurePublisher } from "./publisher"
import { abortable, type FoundryTransport, readJson, requestId } from "./transport"
import { counter, object, PREFIX, positiveInteger } from "./util"

export interface AzureAIFoundryImageOptions {
  /** When to pick this model, for people and the agent. */
  readonly description?: string
  /** Deadline for one generation, response included. Default: 180,000 ms. */
  readonly timeoutMs?: number
  readonly rateCard?: ModelRateCard
  readonly costEstimator?: ImageCostEstimator
}

export interface AzureAIFoundryImageModel extends ImageModel {
  readonly metadata: AzureAIFoundryModelMetadata
  resolve(options?: { readonly offline?: boolean }): Promise<AzureAIFoundryImageModel>
}

/** Ten large PNGs in base64; a reply over it fails, keeping its request ID. */
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024

/** AbortSignal.timeout's largest delay. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

const INPUT_MEDIA_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"])
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}

/**
 * What each family takes through Azure's OpenAI images API. GPT Image returns up to 10 images
 * and edits up to 16 references; FLUX returns one (Azure rejects `n` above 1), FLUX.1 Kontext
 * edits one reference, and FLUX1.1 [pro] edits none.
 */
interface Family {
  readonly gpt: boolean
  readonly definition: Omit<ImageModelDefinition, "kind" | "providerId" | "modelId">
}

const GPT_SIZES = Object.freeze(["auto", "1024x1024", "1536x1024", "1024x1536"])
const GPT_QUALITIES = Object.freeze(["auto", "low", "medium", "high"])
const GPT_INPUT = Object.freeze({
  maxCount: 16,
  maxBytes: 50 * 1024 * 1024,
  mediaTypes: INPUT_MEDIA_TYPES,
})

function family(deployment: AzureAIFoundryDeployment): Family {
  const name = deployment.modelName.toLowerCase()
  if (name.startsWith("gpt-image-"))
    return {
      gpt: true,
      definition: {
        maxImagesPerCall: 10,
        // gpt-image-2 and later take free-form sizes; Azure validates them.
        ...(/^gpt-image-1(\.5|-mini)?$/.test(name) ? { sizes: GPT_SIZES } : {}),
        qualities: GPT_QUALITIES,
        inputImages: GPT_INPUT,
      },
    }
  if (name === "flux.1-kontext-pro")
    return {
      gpt: false,
      definition: {
        maxImagesPerCall: 1,
        inputImages: { maxCount: 1, maxBytes: 20 * 1024 * 1024, mediaTypes: INPUT_MEDIA_TYPES },
      },
    }
  if (name === "flux-1.1-pro") return { gpt: false, definition: { maxImagesPerCall: 1 } }
  // FLUX.2 answers only Black Forest Labs' own route, with a request and per-megapixel price of
  // its own; DALL-E 3 is retired.
  throw new UnsupportedModelFeatureError(
    `${PREFIX} ${deployment.modelName} is not supported: use a GPT Image, FLUX.1 Kontext [pro] or FLUX1.1 [pro] deployment.`
  )
}

/**
 * Azure Retail Prices (verified 2026-11-13), by deployment SKU. GPT Image bills USD per million
 * text input, text output and image output tokens; image input tokens bill at another rate that a
 * rate card cannot hold, so an edit stays unpriced. FLUX bills per image.
 */
interface PublishedImagePrice {
  readonly card: ModelRateCard
  /** Whether Azure publishes a price for text output tokens. */
  readonly textOutput: boolean
}

/**
 * With a text output price, image output tokens are billed apart, which needs the reply's split.
 * Without one, every output token is billed at the image rate: gpt-image-1 reports no split.
 */
const gpt = (input: string, imageOutput: string, textOutput?: string): PublishedImagePrice => ({
  card:
    textOutput === undefined
      ? { currency: "USD", input, output: imageOutput }
      : { currency: "USD", input, output: textOutput, imageOutput },
  textOutput: textOutput !== undefined,
})
const perImage = (images: string): PublishedImagePrice => ({
  card: { currency: "USD", images },
  textOutput: false,
})

const PUBLISHED: Readonly<
  Record<string, { readonly version: string; readonly skus: Record<string, PublishedImagePrice> }>
> = {
  // gpt-image-1-{inp-txt,output-img}-{glbl,dzone}
  "gpt-image-1": {
    version: "2025-04-15",
    skus: { GlobalStandard: gpt("5", "40"), DataZoneStandard: gpt("5.5", "44") },
  },
  // gpt img 1 mini {inp txt,out img} {glbl,dzone}
  "gpt-image-1-mini": {
    version: "2025-10-06",
    skus: { GlobalStandard: gpt("2", "8"), DataZoneStandard: gpt("2.2", "8.8") },
  },
  // gpt img 1.5 {in txt,out img,out txt} {gl,DZ}
  "gpt-image-1.5": {
    version: "2025-12-16",
    skus: {
      GlobalStandard: gpt("5", "32", "10"),
      DataZoneStandard: gpt("5.5", "35.2", "11"),
    },
  },
  // Image 2 {txt inp,img opt} {Gl,DZ}
  "gpt-image-2": {
    version: "2026-04-21",
    skus: { GlobalStandard: gpt("5", "30"), DataZoneStandard: gpt("5.5", "33") },
  },
  // Kontext Pro {glbl,Dzone,regnl} Images
  "flux.1-kontext-pro": {
    version: "1",
    skus: {
      GlobalStandard: perImage("0.04"),
      DataZoneStandard: perImage("0.044"),
      Standard: perImage("0.044"),
    },
  },
  // Flux 1.1 Pro {glbl,Dzone,regnl} Images
  "flux-1.1-pro": {
    version: "1",
    skus: {
      GlobalStandard: perImage("0.04"),
      DataZoneStandard: perImage("0.044"),
      Standard: perImage("0.044"),
    },
  },
}

interface ImageSettings {
  readonly description?: string
  readonly timeoutMs: number
  readonly rateCard?: ModelRateCard
  readonly costEstimator?: ImageCostEstimator
}

interface ImageResolution extends ResolvedDeployment {
  readonly family: Family
  readonly costEstimator?: ImageCostEstimator
  readonly rateCard?: ModelRateCard
}

export function createFoundryImage(
  providerId: string,
  modelId: string,
  options: AzureAIFoundryImageOptions,
  transport: FoundryTransport,
  deployments: FoundryDeployments
): AzureAIFoundryImageModel {
  if (!modelId.trim() || modelId !== modelId.trim())
    throw new TypeError(`${PREFIX} deploymentName must be nonempty without surrounding whitespace.`)
  positiveInteger(options.timeoutMs, "timeoutMs")
  if (options.timeoutMs !== undefined && options.timeoutMs > MAX_TIMEOUT_MS)
    throw new TypeError(`${PREFIX} timeoutMs must be at most ${MAX_TIMEOUT_MS}.`)
  if (
    options.description !== undefined &&
    (typeof options.description !== "string" || !options.description.trim())
  )
    throw new TypeError(`${PREFIX} description must be a nonblank string.`)
  if (options.rateCard && options.costEstimator)
    throw new TypeError(`${PREFIX} Configure either rateCard or costEstimator, not both.`)
  // Validate and snapshot now: later edits to the caller's object change nothing.
  const settings: ImageSettings = Object.freeze({
    timeoutMs: options.timeoutMs ?? 180_000,
    ...(options.description ? { description: options.description } : {}),
    ...(options.rateCard ? { rateCard: defineModelRateCard(options.rateCard) } : {}),
    ...(options.costEstimator ? { costEstimator: options.costEstimator } : {}),
  })
  return imageBinding(providerId, modelId, settings, transport, deployments)
}

/** Discovery pins the deployed model's family and price; inference uses the images API. */
function imageBinding(
  providerId: string,
  modelId: string,
  settings: ImageSettings,
  transport: FoundryTransport,
  deployments: FoundryDeployments,
  resolution?: ImageResolution
): AzureAIFoundryImageModel {
  const deployment = resolution?.deployment
  const definition: ImageModelDefinition = Object.freeze({
    kind: "image",
    providerId,
    modelId,
    ...(deployment ? { publisher: azurePublisher(deployment.modelPublisher) } : {}),
    via: "Azure AI Foundry",
    ...(settings.description ? { description: settings.description } : {}),
    // Sixb checks a request against the binding before resolving it: until then, the most any
    // supported family takes. Resolution narrows it to the deployment's family.
    ...(resolution ? resolution.family.definition : { inputImages: GPT_INPUT }),
  })

  let pending: Promise<AzureAIFoundryImageModel> | undefined
  const binding: AzureAIFoundryImageModel = Object.freeze({
    providerId,
    modelId,
    definition,
    metadata: deploymentMetadata(resolution),
    ...(resolution?.costEstimator ? { costEstimator: resolution.costEstimator } : {}),
    ...(resolution?.rateCard ? { rateCard: resolution.rateCard } : {}),

    async resolve(input?: { readonly offline?: boolean }) {
      if (resolution) return binding
      const resolved = await deployments.resolve(modelId, input?.offline === true)
      assertDeploymentKind(resolved.deployment, modelId, "image")
      const found = family(resolved.deployment)
      const published = settings.costEstimator ? undefined : publishedPrice(resolved.deployment)
      const rateCard = settings.costEstimator ? undefined : (settings.rateCard ?? published?.card)
      return imageBinding(providerId, modelId, settings, transport, deployments, {
        ...resolved,
        family: found,
        ...(rateCard ? { rateCard } : {}),
        ...(settings.costEstimator || rateCard
          ? {
              costEstimator:
                settings.costEstimator ??
                imageEstimator(rateCard!, settings.rateCard ? true : published!.textOutput),
            }
          : {}),
      })
    },

    async generate(request: ImageModelRequest): Promise<ImageModelResult> {
      const signal = AbortSignal.any([
        ...(request.signal ? [request.signal] : []),
        AbortSignal.timeout(settings.timeoutMs),
      ])
      signal.throwIfAborted()
      if (typeof request.prompt !== "string" || !request.prompt.trim())
        throw new TypeError(`${PREFIX} Image prompt must be a nonblank string.`)
      if (!Number.isSafeInteger(request.n) || request.n < 1)
        throw new TypeError(`${PREFIX} Image count must be a positive integer.`)
      if (!resolution) {
        // A direct call pins the deployment once, as the runtime does before admission.
        pending ??= binding.resolve().catch((error) => {
          pending = undefined
          throw error
        })
        const resolved = await abortable(() => pending!, signal)
        return resolved.generate({ ...request, signal })
      }

      const { gpt } = resolution.family
      const { maxImagesPerCall, inputImages } = resolution.family.definition
      if (maxImagesPerCall !== undefined && request.n > maxImagesPerCall)
        throw new TypeError(`${PREFIX} ${modelId} returns at most ${maxImagesPerCall} per call.`)
      const images = request.images ?? []
      if (images.length > (inputImages?.maxCount ?? 0))
        throw new TypeError(
          `${PREFIX} ${modelId} takes at most ${inputImages?.maxCount ?? 0} reference images.`
        )
      for (const image of images)
        if (!EXTENSIONS[image.mediaType] || image.data.byteLength > inputImages!.maxBytes)
          throw new TypeError(
            `${PREFIX} Reference images must be PNG, JPEG or WebP within maxBytes.`
          )

      // The API has no seed, style or aspect ratio; FLUX has no quality.
      const warnings = [
        ...(request.seed === undefined ? [] : ["seed: not supported"]),
        ...(request.style === undefined ? [] : ["style: not supported"]),
        ...(request.aspectRatio === undefined ? [] : ["aspectRatio: not supported; use size"]),
        ...(request.quality === undefined || gpt ? [] : ["quality: not supported"]),
      ]
      // One image is the default; FLUX.1 Kontext's edit form rejects even `n=1`.
      const fields = {
        prompt: request.prompt,
        ...(request.n === 1 ? {} : { n: request.n }),
        ...(request.size === undefined ? {} : { size: request.size }),
        ...(request.quality === undefined || !gpt ? {} : { quality: request.quality }),
      }
      const edit = images.length > 0
      const response = await transport.post(
        edit ? editForm(fields, images, gpt) : JSON.stringify(fields),
        signal,
        providerId,
        modelId,
        edit ? "image-edit" : "image"
      )
      const id = transport.redactText(response, requestId(response))
      const providerIds = id ? { providerIds: { requestId: id } } : {}
      let body: unknown
      try {
        body = await readJson(response, signal, MAX_RESPONSE_BYTES)
      } catch {
        if (signal.aborted) throw signal.reason
        // Azure billed the images: the error keeps the request ID to trace them.
        throw new ImageModelResponseError(
          `${PREFIX} Image generation returned invalid or oversized JSON.`,
          providerId,
          modelId,
          providerIds
        )
      }
      const payload = object(body)
      const decoded = decodeImages(payload?.data)
      const metadata: ImageModelResponseMetadata = {
        // Azure bills every image it returned, readable or not.
        usage: imageUsage(payload, Array.isArray(payload?.data) ? payload.data.length : undefined),
        ...providerIds,
      }
      if (!decoded || decoded.length === 0 || decoded.length > request.n)
        throw new ImageModelResponseError(
          `${PREFIX} Image generation returned no readable images.`,
          providerId,
          modelId,
          metadata
        )
      return {
        ...metadata,
        output: { images: decoded },
        ...(warnings.length ? { warnings } : {}),
      }
    },
  })
  return binding
}

function editForm(
  fields: Readonly<Record<string, string | number>>,
  images: readonly ImageData[],
  gpt: boolean
): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value))
  // GPT Image takes a list of references; FLUX.1 Kontext a single `image`.
  images.forEach((image, index) => {
    const file = new Blob([new Uint8Array(image.data)], { type: image.mediaType })
    form.append(gpt ? "image[]" : "image", file, `image-${index}.${EXTENSIONS[image.mediaType]}`)
  })
  return form
}

/** Images arrive as base64; one that is missing or not a known image format fails the call. */
function decodeImages(value: unknown): ImageData[] | undefined {
  if (!Array.isArray(value)) return undefined
  const images: ImageData[] = []
  for (const entry of value) {
    const encoded = object(entry)?.b64_json
    if (typeof encoded !== "string" || !encoded) return undefined
    const data = new Uint8Array(Buffer.from(encoded, "base64"))
    const mediaType = imageMediaType(data)
    if (!mediaType) return undefined
    images.push({ data, mediaType })
  }
  return images
}

function imageMediaType(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, 12))
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png"
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg"
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP")
    return "image/webp"
  return undefined
}

/**
 * GPT Image reports tokens, image and text output apart; FLUX reports nothing, and is billed by
 * the images returned.
 */
function imageUsage(payload: JsonObject | undefined, images: number | undefined): ModelUsage {
  const raw = object(payload?.usage)
  const output = object(raw?.output_tokens_details)
  const inputTokens = counter(raw?.input_tokens)
  const outputTokens = counter(raw?.output_tokens)
  const imageOutputTokens = counter(output?.image_tokens)
  const textOutputTokens = counter(output?.text_tokens)
  return {
    ...(images === undefined ? {} : { outputImages: images }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(imageOutputTokens === undefined ? {} : { imageOutputTokens }),
    ...(textOutputTokens === undefined ? {} : { textOutputTokens }),
    ...(raw ? { raw } : {}),
  }
}

function publishedPrice(deployment: AzureAIFoundryDeployment): PublishedImagePrice | undefined {
  const name = deployment.modelName.toLowerCase()
  const entry = Object.hasOwn(PUBLISHED, name) ? PUBLISHED[name] : undefined
  if (!entry || entry.version !== deployment.modelVersion) return undefined
  const price = Object.hasOwn(entry.skus, deployment.sku.name)
    ? entry.skus[deployment.sku.name]
    : undefined
  return price && { card: defineModelRateCard(price.card), textOutput: price.textOutput }
}

function imageEstimator(rateCard: ModelRateCard, textOutput: boolean): ImageCostEstimator {
  return {
    // A per-image price bounds a call; token-priced output has no bound before the call.
    estimateReservation: (input) =>
      rateCard.images === undefined
        ? undefined
        : estimateModelReservation({ outputImages: input.n, rateCard }),
    estimate: ({ usage, dimensions }) => {
      const details = object(usage.raw?.input_tokens_details)
      // Image input tokens, from reference images, bill at a rate the card cannot hold; text
      // output without a published price is not billed at the image rate.
      if (
        (details?.image_tokens !== undefined && details.image_tokens !== 0) ||
        (!textOutput && (usage.textOutputTokens ?? 0) > 0)
      )
        return { status: "unpriceable", reason: "missing-rate-card" }
      return rateModelCall({ usage, rateCard, dimensions })
    },
  }
}
