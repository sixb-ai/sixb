import { connectorCodeForStatus, SixbProviderError } from "@sixb/core/errors"
import type { TeamleaderApiErrorItem } from "./types"

export class TeamleaderApiError extends SixbProviderError {
  override readonly name = "TeamleaderApiError"

  constructor(
    readonly status: number,
    readonly errors: readonly TeamleaderApiErrorItem[],
    readonly responseBody: unknown
  ) {
    super(connectorCodeForStatus(status), formatTeamleaderApiError(status, errors), {
      details: { status },
    })
  }
}

function formatTeamleaderApiError(
  status: number,
  errors: readonly TeamleaderApiErrorItem[]
): string {
  const details = errors.map(formatTeamleaderApiErrorItem).filter(Boolean)
  return details.length > 0
    ? `[SixbTeamleader] API request failed with ${status}: ${details.join("; ")}`
    : `[SixbTeamleader] API request failed with ${status}.`
}

function formatTeamleaderApiErrorItem(error: TeamleaderApiErrorItem): string {
  const message = error.title ?? error.detail ?? error.key ?? error.code
  if (!message) {
    return ""
  }

  const field = error.meta?.field
  return field ? `${field}: ${message}` : message
}
