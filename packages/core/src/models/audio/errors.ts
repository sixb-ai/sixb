import { ModelProviderError } from "../errors"
import type { TranscriptionModelResponseMetadata } from "./types"

/** Retains billing metadata even when the provider returns an invalid transcript. */
export class TranscriptionModelResponseError extends ModelProviderError {
  constructor(
    message: string,
    providerId: string,
    modelId: string,
    readonly metadata: TranscriptionModelResponseMetadata,
    options?: ErrorOptions
  ) {
    super(message, providerId, modelId, {
      ...options,
      code: "invalid_transcription_response",
      retryable: false,
    })
  }
}
