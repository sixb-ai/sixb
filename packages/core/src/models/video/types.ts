import type { FileRef } from "../../blob-storage/types"
import type { JsonValue, ReadonlyJsonValue } from "../../json"
import type { ModelDefinition } from "../definitions"
import type { ModelProviderIds, ModelRoute, ModelUsage } from "../events"
import type { ModelCallCost, ModelCostEstimator, ModelMoney, ModelReportedCost } from "../pricing"
import type { ModelPricingDimensions, ModelRateCard } from "../rate-card"

/** Serializable facts about one video model. Omitted lists mean the provider publishes none. */
export interface VideoModelDefinition extends ModelDefinition {
  readonly kind: "video"
  readonly maxVideosPerCall?: number
  /** Accepted frame sizes, such as `1280x720`. */
  readonly resolutions?: readonly string[]
  readonly aspectRatios?: readonly string[]
  /** Accepted lengths, in whole seconds. */
  readonly durations?: readonly number[]
  /** Whether the model can make sound with the picture. */
  readonly audio?: boolean
  /** Images a clip starts from, ends on or takes after; omitted when the model takes none. */
  readonly inputImages?: {
    readonly maxCount: number
    /** Bounds memory consumption before a file is opened. Providers may impose lower limits. */
    readonly maxBytes: number
    readonly mediaTypes?: readonly string[]
  }
}

/** Video bytes with the media type the provider resolved. */
export interface VideoData {
  readonly data: Uint8Array
  readonly mediaType: string
}

/**
 * An input image: a URL the provider fetches itself, which keeps a start request small, or its
 * bytes when Sixb cannot issue a URL the provider can reach.
 */
export type VideoInputImage =
  | { readonly url: string; readonly mediaType: string }
  | { readonly data: Uint8Array; readonly mediaType: string }

export interface VideoModelRequest {
  /** Stable for the call: a provider deduplicates a retried start on it. */
  readonly callId: string
  readonly prompt: string
  readonly n: number
  readonly durationSeconds?: number
  readonly resolution?: string
  readonly aspectRatio?: string
  readonly audio?: boolean
  readonly seed?: number
  readonly firstFrame?: VideoInputImage
  readonly lastFrame?: VideoInputImage
  readonly referenceImages: readonly VideoInputImage[]
  readonly signal?: AbortSignal
}

export interface VideoModelResponseMetadata {
  readonly usage?: ModelUsage
  readonly providerIds?: ModelProviderIds
  readonly responseModelId?: string
  readonly reportedCost?: ModelReportedCost
  readonly route?: ModelRoute
}

/** A generation the provider accepted. */
export interface VideoModelStart {
  /** The provider's handle on the job, kept as JSON until the job ends. */
  readonly operation: JsonValue
  /** The price variant the provider bills the job at, such as `{ resolution: "720p" }`. */
  readonly pricingDimensions?: ModelPricingDimensions
  /** Provider notes about the request, such as a setting it ignored. */
  readonly warnings?: readonly string[]
}

/** One look at a started generation. */
export type VideoModelStatus =
  | { readonly status: "pending" }
  | (VideoModelResponseMetadata & {
      readonly status: "completed"
      readonly output: { readonly videos: readonly VideoData[] }
      readonly warnings?: readonly string[]
    })
  | (VideoModelResponseMetadata & {
      readonly status: "failed"
      /** What the provider said went wrong, for the person who asked. */
      readonly error: string
    })

export interface VideoReservationInput {
  readonly n: number
  /** Absent when the request leaves the length to the model. */
  readonly durationSeconds?: number
  readonly resolution?: string
  readonly audio?: boolean
  /** UTF-8 bytes of the prompt divided by four, rounded up. */
  readonly promptTokens: number
  readonly inputImages: number
}

export interface VideoCostEstimator extends Pick<ModelCostEstimator, "estimate"> {
  /** Return undefined if the request cannot be priced safely before inference. */
  estimateReservation?(input: VideoReservationInput): ModelMoney | undefined
}

/**
 * Provider binding. Resolving it may fetch metadata, but must never perform inference. A video
 * takes minutes, so a generation is started, then checked until it ends.
 */
export interface VideoModel {
  readonly providerId: string
  readonly modelId: string
  readonly definition: VideoModelDefinition
  readonly costEstimator?: VideoCostEstimator
  /**
   * The prices this binding bills by, for people and agents choosing a model. Pricing itself
   * goes through costEstimator; absent when the price is unknown.
   */
  readonly rateCard?: ModelRateCard
  resolve?(): Promise<VideoModel>
  /** Returns as soon as the provider accepts the job. */
  start(request: VideoModelRequest): Promise<VideoModelStart>
  /**
   * One look at a started job. A job the provider failed is `failed`; a failure to ask, such as
   * a network error, is thrown and leaves the job running.
   */
  status(input: {
    readonly operation: ReadonlyJsonValue
    readonly signal?: AbortSignal
  }): Promise<VideoModelStatus>
}

export interface VideoGenerateInput {
  readonly prompt: string
  /** Defaults to 1. */
  readonly n?: number
  /** In whole seconds. Omitted, the model picks its default length. */
  readonly duration?: number
  /** A frame size, such as `1280x720`. */
  readonly resolution?: string
  readonly aspectRatio?: string
  /** Whether to make sound with the picture, where the model can. */
  readonly audio?: boolean
  readonly seed?: number
  /** The image the clip starts from. */
  readonly firstFrame?: FileRef
  /** The image the clip ends on. */
  readonly lastFrame?: FileRef
  /** Images of the characters, objects or style the clip should show. */
  readonly referenceImages?: readonly FileRef[]
  /** One of `models.video`, which later checks find it in. Defaults to the first. */
  readonly model?: VideoModel
  readonly signal?: AbortSignal
}

export type VideoGenerationStatus = "pending" | "completed" | "failed"

/** A video generation, as far as it got. */
export interface VideoGeneration {
  readonly callId: string
  readonly model: { readonly providerId: string; readonly modelId: string }
  readonly status: VideoGenerationStatus
  /** Generated videos, already written to blob storage; empty until the generation completes. */
  readonly files: readonly FileRef[]
  readonly warnings: readonly string[]
  /** What the provider said went wrong, once the generation failed. */
  readonly error?: string
  /** Present once the generation ended. */
  readonly usage?: ModelUsage
  readonly cost?: ModelCallCost
  readonly createdAt: Date
}

export interface VideoGenerateResult {
  /** Generated videos, already written to blob storage. */
  readonly files: readonly FileRef[]
  readonly warnings: readonly string[]
  readonly usage: ModelUsage
  readonly cost: ModelCallCost
  readonly callId: string
}

export interface VideoModelsRuntime {
  /** Generate and wait for the videos: minutes, for most models. */
  generate(input: VideoGenerateInput): Promise<VideoGenerateResult>
  /** Start a generation and return at once; `get` follows it. */
  start(input: VideoGenerateInput): Promise<VideoGeneration>
  /**
   * Where a generation stands, checking with the provider while it runs; the check that sees it
   * end stores the videos and records the call. Null when the call is unknown or hidden: it is
   * as visible as the run that started it.
   */
  get(callId: string): Promise<VideoGeneration | null>
}
