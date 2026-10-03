import type { FileRef } from "../../blob-storage/types"
import type { ModelDefinition } from "../definitions"
import type { ModelProviderIds, ModelRoute, ModelUsage } from "../events"
import type { ModelCallCost, ModelCostEstimator, ModelMoney, ModelReportedCost } from "../pricing"

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

export interface AudioModelsRuntime {
  transcribe(input: AudioTranscribeInput): Promise<AudioTranscribeResult>
}
