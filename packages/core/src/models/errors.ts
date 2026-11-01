import type { ModelFinishReason, ModelUsage } from "./events"
import type { ModelCallCost } from "./pricing"

/** Catalog transport/access failed; callers may use local metadata without masking invalid definitions. */
export class ModelCatalogUnavailableError extends Error {
  readonly name = "ModelCatalogUnavailableError"
}

/**
 * Why a provider rejected a request, when the provider says so in terms Sixb acts on:
 * `context-window-exceeded` means the request was too long for the model's context window, and a
 * shorter one may succeed.
 */
export type ModelProviderErrorReason = "context-window-exceeded"

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
      readonly reason?: ModelProviderErrorReason
    }
  ) {
    super(message, options)
    this.status = options?.status
    this.code = options?.code
    this.requestId = options?.requestId
    this.retryAfterMs = options?.retryAfterMs
    this.retryable = options?.retryable ?? false
    this.reason = options?.reason
  }

  readonly status?: number
  readonly code?: string
  readonly requestId?: string
  readonly retryAfterMs?: number
  readonly retryable: boolean
  readonly reason?: ModelProviderErrorReason
}

export class ModelStreamError extends Error {
  readonly name = "ModelStreamError"
}

export class UnsupportedModelFeatureError extends Error {
  readonly name = "UnsupportedModelFeatureError"

  constructor(
    message?: string,
    options?: ErrorOptions & {
      readonly reason?: "unsupported-model" | "unsupported-schema"
    }
  ) {
    super(message, options)
    this.reason = options?.reason
  }

  readonly reason?: "unsupported-model" | "unsupported-schema"
}

export class StructuredOutputError extends Error {
  readonly name = "StructuredOutputError"

  constructor(
    message: string,
    options?: ErrorOptions & {
      readonly text?: string
      readonly providerId?: string
      readonly modelId?: string
      readonly responseId?: string
      readonly responseModelId?: string
      readonly finishReason?: ModelFinishReason
      readonly usage?: ModelUsage
      readonly cost?: ModelCallCost
    }
  ) {
    super(message, options)
    this.text = options?.text
    this.providerId = options?.providerId
    this.modelId = options?.modelId
    this.responseId = options?.responseId
    this.responseModelId = options?.responseModelId
    this.finishReason = options?.finishReason
    this.usage = options?.usage
    this.cost = options?.cost
  }

  readonly text?: string
  readonly providerId?: string
  readonly modelId?: string
  readonly responseId?: string
  readonly responseModelId?: string
  readonly finishReason?: ModelFinishReason
  readonly usage?: ModelUsage
  readonly cost?: ModelCallCost
}
