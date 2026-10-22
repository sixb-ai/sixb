import type { FileRef } from "../../blob-storage/types"
import type { ModelDefinition } from "../definitions"
import type { ModelProviderIds, ModelRoute, ModelUsage } from "../events"
import type { ModelCallCost, ModelCostEstimator, ModelMoney, ModelReportedCost } from "../pricing"
import type { ModelPricingDimensions } from "../rate-card"

/** Serializable facts about one image model. Omitted lists mean the provider publishes none. */
export interface ImageModelDefinition extends ModelDefinition {
  readonly kind: "image"
  readonly maxImagesPerCall?: number
  /** Accepted `size` values, such as `1024x1024` or `1K`. */
  readonly sizes?: readonly string[]
  readonly aspectRatios?: readonly string[]
  readonly qualities?: readonly string[]
  readonly styles?: readonly string[]
  /** Reference images for edits; omitted when the model takes none. */
  readonly inputImages?: {
    readonly maxCount: number
    /** Bounds memory consumption before a file is opened. Providers may impose lower limits. */
    readonly maxBytes: number
    readonly mediaTypes?: readonly string[]
  }
}

/** Image bytes with the media type the provider resolved. */
export interface ImageData {
  readonly data: Uint8Array
  readonly mediaType: string
}

export interface ImageModelRequest {
  readonly prompt: string
  readonly n: number
  readonly size?: string
  readonly aspectRatio?: string
  readonly quality?: string
  readonly style?: string
  readonly seed?: number
  readonly images: readonly ImageData[]
  readonly signal?: AbortSignal
}

export interface ImageModelResponseMetadata {
  readonly usage?: ModelUsage
  readonly providerIds?: ModelProviderIds
  readonly responseModelId?: string
  readonly reportedCost?: ModelReportedCost
  readonly route?: ModelRoute
}

export interface ImageModelResult extends ImageModelResponseMetadata {
  readonly output: { readonly images: readonly ImageData[] }
  /** Provider notes about the request, such as a setting it ignored. */
  readonly warnings?: readonly string[]
}

export interface ImageReservationInput {
  readonly n: number
  /** UTF-8 bytes of the prompt divided by four, rounded up. */
  readonly promptTokens: number
  readonly inputImages: number
  readonly dimensions: ModelPricingDimensions
}

export interface ImageCostEstimator extends Pick<ModelCostEstimator, "estimate"> {
  /** Return undefined if the request cannot be priced safely before inference. */
  estimateReservation?(input: ImageReservationInput): ModelMoney | undefined
}

/** Provider binding. Resolving it may fetch metadata, but must never perform inference. */
export interface ImageModel {
  readonly providerId: string
  readonly modelId: string
  readonly definition: ImageModelDefinition
  readonly costEstimator?: ImageCostEstimator
  resolve?(): Promise<ImageModel>
  generate(request: ImageModelRequest): Promise<ImageModelResult>
}

export interface ImageGenerateInput {
  readonly prompt: string
  /** Defaults to 1. */
  readonly n?: number
  readonly size?: string
  readonly aspectRatio?: string
  readonly quality?: string
  readonly style?: string
  readonly seed?: number
  /** Reference images for an edit or variation. */
  readonly images?: readonly FileRef[]
  readonly model?: ImageModel
  readonly signal?: AbortSignal
}

export interface ImageGenerateResult {
  /** Generated images, already written to blob storage. */
  readonly files: readonly FileRef[]
  readonly warnings: readonly string[]
  readonly usage: ModelUsage
  readonly cost: ModelCallCost
  readonly callId: string
}

export interface ImageModelsRuntime {
  generate(input: ImageGenerateInput): Promise<ImageGenerateResult>
}
