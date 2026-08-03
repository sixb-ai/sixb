import { connectorCodeForStatus, SixbError } from "@sixb/core/errors"
/** Raised when the PandaDoc API returns a non-2xx response. */
export class PandaDocApiError extends SixbError {
  override readonly name = "PandaDocApiError"

  constructor(
    readonly status: number,
    readonly responseBody: unknown,
    readonly responseHeaders: Headers
  ) {
    super(connectorCodeForStatus(status), formatPandaDocApiError(status, responseBody), {
      details: { status },
    })
  }
}

function formatPandaDocApiError(status: number, responseBody: unknown): string {
  const message = extractMessage(responseBody)
  return message
    ? `[SixbPandaDoc] PandaDoc API request failed with ${status}: ${message}`
    : `[SixbPandaDoc] PandaDoc API request failed with ${status}.`
}

function extractMessage(value: unknown): string | null {
  if (typeof value === "string") {
    return value
  }

  if (!isRecord(value)) {
    return null
  }

  for (const key of ["detail", "message", "error", "type"]) {
    const candidate = value[key]
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate
    }
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
