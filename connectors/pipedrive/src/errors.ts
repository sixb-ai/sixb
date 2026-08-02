import { connectorCodeForStatus, SixbProviderError } from "@sixb/core/errors"
export class PipedriveApiError extends SixbProviderError {
  override readonly name = "PipedriveApiError"

  constructor(
    readonly status: number,
    readonly responseBody: unknown
  ) {
    super(connectorCodeForStatus(status), formatPipedriveApiError(status, responseBody), {
      details: { status },
    })
  }
}

function formatPipedriveApiError(status: number, responseBody: unknown): string {
  const message = extractMessage(responseBody)
  return message
    ? `[SixbPipedrive] Pipedrive API request failed with ${status}: ${message}`
    : `[SixbPipedrive] Pipedrive API request failed with ${status}.`
}

function extractMessage(value: unknown): string | null {
  if (typeof value === "string") {
    return value
  }

  if (!isRecord(value)) {
    return null
  }

  for (const key of ["error", "error_info", "message"]) {
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
