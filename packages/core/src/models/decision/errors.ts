import { ModelProviderError } from "../errors"
import type { DecisionModelResponseMetadata } from "./types"

export class DecisionModelResponseError extends ModelProviderError {
  constructor(
    message: string,
    providerId: string,
    modelId: string,
    readonly metadata: DecisionModelResponseMetadata,
    options?: ErrorOptions
  ) {
    super(message, providerId, modelId, {
      ...options,
      code: "invalid_decision_response",
      retryable: false,
    })
  }
}
