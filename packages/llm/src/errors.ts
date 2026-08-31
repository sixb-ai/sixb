export class ModelProviderError extends Error {
  readonly name = "ModelProviderError"

  constructor(
    message: string,
    readonly providerId: string,
    readonly modelId: string,
    options?: ErrorOptions & { readonly status?: number; readonly code?: string }
  ) {
    super(message, options)
    this.status = options?.status
    this.code = options?.code
  }

  readonly status?: number
  readonly code?: string
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
