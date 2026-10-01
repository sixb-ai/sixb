import { AgentToolPublicError } from "@sixb/core"

/**
 * Raised when a FullEnrich request fails or returns an unusable response.
 *
 * Messages carry only the HTTP status and FullEnrich's error `code` and `message`, so agent tools
 * may surface them to the model.
 */
export class FullEnrichApiError extends AgentToolPublicError {
  override readonly name = "FullEnrichApiError"
  /** HTTP status, absent when the API could not be reached. */
  readonly status?: number
  /** FullEnrich's error code, such as `error.enrichment.in_progress` or `error.rate.limit`. */
  readonly code?: string

  constructor(
    message: string,
    options: {
      readonly status?: number
      readonly code?: string
      readonly cause?: unknown
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.status = options.status
    this.code = options.code
  }
}
