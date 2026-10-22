import { randomUUID } from "node:crypto"
import { assertProviderAccess } from "../../authorization"
import type { BlobStorage, FileRef } from "../../blob-storage/types"
import type { ExecutionContext } from "../../execution"
import type { SixbRuntimeContext } from "../../runtime/types"
import type { ModelCatalog } from "../catalog"
import type { ModelCallEndEvent } from "../events"
import type { AiModelCallRecorder } from "../execution/model-call-recorder"
import type { ModelExecutionSession } from "../execution/session"
import { prepareModelInputFile, readModelInputFile } from "../input-file"
import { estimateModelCall, type ModelMoney } from "../pricing"
import type { ModelPricingDimensions } from "../rate-card"
import { assertImageModel } from "./catalog"
import { ImageModelResponseError } from "./errors"
import type {
  ImageData,
  ImageGenerateInput,
  ImageModel,
  ImageModelResponseMetadata,
  ImageModelResult,
  ImageModelsRuntime,
  ImageReservationInput,
} from "./types"

interface PreparedRequest {
  readonly prompt: string
  readonly n: number
  readonly size?: string
  readonly aspectRatio?: string
  readonly quality?: string
  readonly style?: string
  readonly seed?: number
  readonly images: readonly { readonly file: FileRef; readonly mediaType: string }[]
}

export function createImageRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  catalog: ModelCatalog | undefined,
  session: ModelExecutionSession,
  blobs: BlobStorage | undefined
): ImageModelsRuntime {
  return {
    async generate(input) {
      assertProviderAccess(runtime, execution, "models.image.generate")

      const request = prepareRequest(input)
      if (!blobs) {
        throw new Error("[SixbModels] Image generation requires blob storage.")
      }

      const signal = session.signal(input.signal)
      signal.throwIfAborted()

      const binding = selectModel(catalog, input.model)
      assertImageModel(binding)
      assertRequestSupport(binding, request)

      const accounting = await session.accounting()
      accounting.assertHealthy()

      const model = binding.resolve ? await binding.resolve() : binding
      assertImageModel(model)
      if (model.providerId !== binding.providerId || model.modelId !== binding.modelId) {
        throw new TypeError(
          "[SixbModels] Resolved image model identity does not match the selected model."
        )
      }
      assertRequestSupport(model, request)

      const images: ImageData[] = []
      for (const image of request.images) {
        signal.throwIfAborted()
        images.push({
          data: await readModelInputFile(blobs, image.file, signal),
          mediaType: image.mediaType,
        })
      }
      accounting.assertHealthy()

      const dimensions = pricingDimensions(request)
      const promptTokens = Math.ceil(new TextEncoder().encode(request.prompt).byteLength / 4)
      const callId = `call_${randomUUID()}`
      await accounting.admitCall({
        callId,
        providerId: model.providerId,
        modelId: model.modelId,
        modelKind: "image",
        inputTokens:
          images.length > 0
            ? { status: "unavailable", reason: "nonTextInput" }
            : { status: "estimated", tokens: promptTokens, method: "utf8BytesDividedByFour" },
        outputTokenAllowance: 0,
        reservationCost: estimateReservationCost(model, {
          n: request.n,
          promptTokens,
          inputImages: images.length,
          dimensions,
        }),
      })

      let result: ImageModelResult
      try {
        signal.throwIfAborted()
        result = await model.generate({
          prompt: request.prompt,
          n: request.n,
          ...(request.size === undefined ? {} : { size: request.size }),
          ...(request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio }),
          ...(request.quality === undefined ? {} : { quality: request.quality }),
          ...(request.style === undefined ? {} : { style: request.style }),
          ...(request.seed === undefined ? {} : { seed: request.seed }),
          images,
          signal,
        })
      } catch (error) {
        await recordImages(
          accounting,
          model,
          callId,
          error instanceof ImageModelResponseError ? error.metadata : {},
          undefined,
          dimensions
        )
        throw error
      }

      // A completed, billable reply must survive cancellation and image validation failures.
      const returned = Array.isArray(result?.output?.images) ? result.output.images : undefined
      const event = await recordImages(
        accounting,
        model,
        callId,
        result ?? {},
        returned?.length,
        dimensions
      )
      signal.throwIfAborted()
      if (!returned?.length || !returned.every(isImageData) || !isWarnings(result.warnings)) {
        throw new ImageModelResponseError(
          "[SixbModels] Invalid image response.",
          model.providerId,
          model.modelId,
          result ?? {}
        )
      }

      const files: FileRef[] = []
      for (const image of returned) {
        files.push(
          await blobs.put({
            body: image.data,
            expectedSizeBytes: image.data.byteLength,
            mediaType: image.mediaType,
            signal,
          })
        )
      }
      await accounting.recordFiles(callId, files)

      return {
        files,
        warnings: [...(result.warnings ?? [])],
        usage: event.usage,
        cost: event.cost,
        callId,
      }
    },
  }
}

/** Validate and snapshot the caller's request before the first await. */
function prepareRequest(input: ImageGenerateInput): PreparedRequest {
  if (typeof input?.prompt !== "string" || !input.prompt.trim()) {
    throw new TypeError("[SixbModels] Image generation requires a nonblank prompt.")
  }
  const n = input.n ?? 1
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new TypeError("[SixbModels] Image count 'n' must be a positive safe integer.")
  }
  for (const field of ["size", "aspectRatio", "quality", "style"] as const) {
    const value = input[field]
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new TypeError(`[SixbModels] Image ${field} must be a nonblank string.`)
    }
  }
  if (input.seed !== undefined && !Number.isSafeInteger(input.seed)) {
    throw new TypeError("[SixbModels] Image seed must be a safe integer.")
  }
  if (input.images !== undefined && !Array.isArray(input.images)) {
    throw new TypeError("[SixbModels] Reference images must be an array of FileRefs.")
  }

  return {
    prompt: input.prompt,
    n,
    ...(input.size === undefined ? {} : { size: input.size }),
    ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
    ...(input.quality === undefined ? {} : { quality: input.quality }),
    ...(input.style === undefined ? {} : { style: input.style }),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    images: (input.images ?? []).map((image) => prepareModelInputFile(image, "image")),
  }
}

function selectModel(
  catalog: ModelCatalog | undefined,
  requested: ImageModel | undefined
): ImageModel {
  if (!catalog && requested) return requested

  // The catalog owns the binding, even when a caller supplies another object with the same ID.
  const models = catalog?.image
  const selected = requested
    ? models?.getByRef({ provider: requested.providerId, modelId: requested.modelId })?.model
    : models?.default.model

  if (!selected) {
    throw new Error(
      "[SixbModels] Configure the selected model in models.image, or supply a model when no catalog is configured."
    )
  }

  return selected
}

function assertRequestSupport(model: ImageModel, request: PreparedRequest): void {
  const definition = model.definition
  if (definition.maxImagesPerCall !== undefined && request.n > definition.maxImagesPerCall) {
    throw new RangeError(
      `[SixbModels] The selected model returns at most ${definition.maxImagesPerCall} images per call.`
    )
  }
  for (const [field, list] of [
    ["size", definition.sizes],
    ["aspectRatio", definition.aspectRatios],
    ["quality", definition.qualities],
    ["style", definition.styles],
  ] as const) {
    const value = request[field]
    if (value !== undefined && list && !list.includes(value)) {
      throw new TypeError(
        `[SixbModels] Image ${field} '${value}' is not supported by the selected model.`
      )
    }
  }

  if (request.images.length === 0) return
  const accepted = definition.inputImages
  if (!accepted) {
    throw new TypeError("[SixbModels] The selected model does not accept reference images.")
  }
  if (request.images.length > accepted.maxCount) {
    throw new RangeError(
      `[SixbModels] The selected model accepts at most ${accepted.maxCount} reference images.`
    )
  }
  for (const image of request.images) {
    if (image.file.sizeBytes > accepted.maxBytes) {
      throw new RangeError(
        `[SixbModels] Reference image exceeds the model's ${accepted.maxBytes}-byte input limit.`
      )
    }
    if (accepted.mediaTypes && !accepted.mediaTypes.includes(image.mediaType)) {
      throw new TypeError(
        `[SixbModels] Image media type '${image.mediaType}' is not supported by the selected model.`
      )
    }
  }
}

function pricingDimensions(request: PreparedRequest): ModelPricingDimensions {
  return {
    ...(request.size === undefined ? {} : { size: request.size }),
    ...(request.quality === undefined ? {} : { quality: request.quality }),
    ...(request.style === undefined ? {} : { style: request.style }),
  }
}

function estimateReservationCost(
  model: ImageModel,
  input: ImageReservationInput
): ModelMoney | undefined {
  try {
    return model.costEstimator?.estimateReservation?.(input)
  } catch {
    // Optional pricing cannot bypass an enforced budget: admission fails closed without it.
    return undefined
  }
}

async function recordImages(
  accounting: AiModelCallRecorder,
  model: ImageModel,
  callId: string,
  metadata: ImageModelResponseMetadata,
  returnedImages: number | undefined,
  dimensions: ModelPricingDimensions
): Promise<ModelCallEndEvent> {
  // The images actually returned are the count that was billed, whatever the provider reports.
  const usage = {
    ...metadata.usage,
    ...(returnedImages === undefined ? {} : { outputImages: returnedImages }),
  }
  const estimate = estimateModelCall(model, {
    usage,
    route: metadata.route,
    responseModelId: metadata.responseModelId,
    dimensions,
  })
  const event: ModelCallEndEvent = {
    callId,
    modelKind: "image",
    providerId: model.providerId,
    modelId: model.modelId,
    responseId: metadata.providerIds?.responseId ?? callId,
    providerIds: metadata.providerIds,
    responseModelId: metadata.responseModelId,
    usage,
    cost: metadata.reportedCost ? { status: "reported", ...metadata.reportedCost } : estimate,
    ...(metadata.reportedCost ? { estimate } : {}),
    route: metadata.route,
  }

  await accounting.onModelCallEnd(event)
  return event
}

function isImageData(value: unknown): value is ImageData {
  const image = value as Partial<ImageData> | null
  return (
    image?.data instanceof Uint8Array &&
    image.data.byteLength > 0 &&
    typeof image.mediaType === "string" &&
    /^image\/[a-z0-9.+-]+$/.test(image.mediaType)
  )
}

function isWarnings(value: unknown): value is readonly string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((w) => typeof w === "string"))
}
