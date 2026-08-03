/** Raised when an Exa request fails or returns an unusable response. */
export class ExaApiError extends Error {
  readonly status?: number
  readonly tag?: string
  readonly requestId?: string

  constructor(
    message: string,
    options: {
      readonly status?: number
      readonly tag?: string
      readonly requestId?: string
      readonly cause?: unknown
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "ExaApiError"
    this.status = options.status
    this.tag = options.tag
    this.requestId = options.requestId
  }
}
