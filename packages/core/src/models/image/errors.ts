import { ModelProviderError } from "../errors"
import type { ImageModelResponseMetadata } from "./types"

/** Retains billing metadata even when the provider returns invalid images. */
export class ImageModelResponseError extends ModelProviderError {
  constructor(
    message: string,
    providerId: string,
    modelId: string,
    readonly metadata: ImageModelResponseMetadata,
    options?: ErrorOptions
  ) {
    super(message, providerId, modelId, {
      ...options,
      code: "invalid_image_response",
      retryable: false,
    })
  }
}
