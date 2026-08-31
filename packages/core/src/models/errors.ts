/** A provider or provider protocol rejected a model request. */
export class ModelProviderError extends Error {
  readonly name = "ModelProviderError"

  constructor(
    message: string,
    readonly providerId: string,
    readonly modelId: string,
    options?: ErrorOptions & {
      readonly status?: number
      readonly code?: string
      readonly requestId?: string
      readonly retryAfterMs?: number
      readonly retryable?: boolean
    }
  ) {
    super(message, options)
    this.status = options?.status
    this.code = options?.code
    this.requestId = options?.requestId
    this.retryAfterMs = options?.retryAfterMs
    this.retryable = options?.retryable ?? false
  }

  readonly status?: number
  readonly code?: string
  readonly requestId?: string
  readonly retryAfterMs?: number
  readonly retryable: boolean
}

export class ModelStreamError extends Error {
  readonly name = "ModelStreamError"
}

export class UnsupportedModelFeatureError extends Error {
  readonly name = "UnsupportedModelFeatureError"
}

export class StructuredOutputError extends Error {
  readonly name = "StructuredOutputError"
}
