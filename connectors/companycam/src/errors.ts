import { connectorCodeForStatus, SixbError } from "@sixb/core/errors"
/** Raised when the CompanyCam API returns a non-2xx response. */
export class CompanyCamApiError extends SixbError {
  override readonly name = "CompanyCamApiError"

  constructor(
    readonly status: number,
    readonly responseBody: string
  ) {
    super(
      connectorCodeForStatus(status),
      `[SixbCompanyCam] API request failed with ${status}: ${responseBody || "(empty body)"}`,
      { details: { status } }
    )
  }
}
