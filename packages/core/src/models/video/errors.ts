import { ModelProviderError } from "../errors"
import type { VideoModelResponseMetadata } from "./types"

/** Retains billing metadata even when the provider returns invalid videos. */
export class VideoModelResponseError extends ModelProviderError {
  constructor(
    message: string,
    providerId: string,
    modelId: string,
    readonly metadata: VideoModelResponseMetadata,
    options?: ErrorOptions
  ) {
    super(message, providerId, modelId, {
      ...options,
      code: "invalid_video_response",
      retryable: false,
    })
  }
}
