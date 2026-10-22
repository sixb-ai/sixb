import type { FileRef } from "../../blob-storage/types"
import type { ModelDefinition } from "../definitions"
import type { ModelProviderIds, ModelRoute, ModelUsage } from "../events"
import type { ModelCallCost, ModelCostEstimator, ModelMoney, ModelReportedCost } from "../pricing"
import type { ModelPricingDimensions } from "../rate-card"

export interface TranscriptionModelDefinition extends ModelDefinition {
  readonly kind: "transcription"
  /** Bounds memory consumption before a file is opened. Providers may impose lower limits. */
  readonly maxInputBytes: number
  /** Omitted when the provider does not publish a reliable format list. */
  readonly mediaTypes?: readonly string[]
}

export interface TranscriptionModelRequest {
  readonly audio: Uint8Array
  readonly mediaType: string
  readonly signal?: AbortSignal
}

export interface TranscriptionOutput {
  readonly text: string
}

export interface TranscriptionModelResponseMetadata {
  readonly usage?: ModelUsage
  readonly providerIds?: ModelProviderIds
  readonly responseModelId?: string
  readonly reportedCost?: ModelReportedCost
  readonly route?: ModelRoute
}

export interface TranscriptionModelResult extends TranscriptionModelResponseMetadata {
  readonly output: TranscriptionOutput
}

export interface TranscriptionCostEstimator extends Pick<ModelCostEstimator, "estimate"> {
  /** Return undefined if the request cannot be priced safely before inference. */
  estimateReservation?(input: {
    readonly sizeBytes: number
    readonly mediaType: string
  }): ModelMoney | undefined
}

/** Provider binding. Resolving it may fetch metadata, but must never perform inference. */
export interface TranscriptionModel {
  readonly providerId: string
  readonly modelId: string
  readonly definition: TranscriptionModelDefinition
  readonly costEstimator?: TranscriptionCostEstimator
  resolve?(): Promise<TranscriptionModel>
  transcribe(request: TranscriptionModelRequest): Promise<TranscriptionModelResult>
}

export interface AudioTranscribeInput {
  readonly audio: FileRef
  readonly model?: TranscriptionModel
  readonly signal?: AbortSignal
}

export interface AudioTranscribeResult {
  readonly output: TranscriptionOutput
  readonly usage: ModelUsage
  readonly cost: ModelCallCost
  readonly callId: string
}

/** Serializable facts about one speech model. Omitted lists mean the provider publishes none. */
export interface SpeechModelDefinition extends ModelDefinition {
  readonly kind: "speech"
  /** In UTF-16 code units (JavaScript string length). Providers may impose lower limits. */
  readonly maxInputCharacters?: number
  readonly voices?: readonly string[]
  /** Formats the model can return, such as `audio/mpeg`. Sixb never transcodes. */
  readonly outputMediaTypes?: readonly string[]
  /** Whether the model takes style instructions. Undefined is unknown. */
  readonly instructions?: boolean
}

export interface SpeechModelRequest {
  readonly text: string
  readonly voice?: string
  readonly instructions?: string
  readonly mediaType?: string
  readonly speed?: number
  readonly language?: string
  readonly signal?: AbortSignal
}

export interface SpeechModelResponseMetadata {
  readonly usage?: ModelUsage
  readonly providerIds?: ModelProviderIds
  readonly responseModelId?: string
  readonly reportedCost?: ModelReportedCost
  readonly route?: ModelRoute
  /** What the provider billed by, such as the tier of the voice it used. */
  readonly pricingDimensions?: ModelPricingDimensions
}

export interface SpeechModelResult extends SpeechModelResponseMetadata {
  /** A playable file: providers whose API returns raw samples wrap them, for example in WAV. */
  readonly output: { readonly audio: { readonly data: Uint8Array; readonly mediaType: string } }
  /** Provider notes about the request, such as a setting it ignored. */
  readonly warnings?: readonly string[]
}

export interface SpeechReservationInput {
  /** The binding counts characters by its provider's own rule. */
  readonly text: string
  readonly voice?: string
  readonly instructions?: string
}

export interface SpeechCostEstimator extends Pick<ModelCostEstimator, "estimate"> {
  /** Return undefined if the request cannot be priced safely before inference. */
  estimateReservation?(input: SpeechReservationInput): ModelMoney | undefined
}

/** Provider binding. Resolving it may fetch metadata, but must never perform inference. */
export interface SpeechModel {
  readonly providerId: string
  readonly modelId: string
  readonly definition: SpeechModelDefinition
  /** Used when a request names no voice, so switching models never requires one. */
  readonly defaultVoice?: string
  readonly costEstimator?: SpeechCostEstimator
  resolve?(): Promise<SpeechModel>
  speak(request: SpeechModelRequest): Promise<SpeechModelResult>
}

export interface AudioSpeakInput {
  readonly text: string
  /** Defaults to the binding's default voice. */
  readonly voice?: string
  readonly instructions?: string
  /** The format to return, such as `audio/mpeg`. Defaults to the provider's. */
  readonly mediaType?: string
  readonly speed?: number
  readonly language?: string
  readonly model?: SpeechModel
  readonly signal?: AbortSignal
}

export interface AudioSpeakResult {
  /** The generated audio, already written to blob storage. */
  readonly file: FileRef
  readonly warnings: readonly string[]
  readonly usage: ModelUsage
  readonly cost: ModelCallCost
  readonly callId: string
}

export interface AudioModelsRuntime {
  transcribe(input: AudioTranscribeInput): Promise<AudioTranscribeResult>
  speak(input: AudioSpeakInput): Promise<AudioSpeakResult>
}
