/** Raised when the CompanyCam API returns a non-2xx response. */
export class CompanyCamApiError extends Error {
  readonly name = "CompanyCamApiError"

  constructor(
    readonly status: number,
    readonly responseBody: string
  ) {
    super(`[SixbCompanyCam] API request failed with ${status}: ${responseBody || "(empty body)"}`)
  }
}
