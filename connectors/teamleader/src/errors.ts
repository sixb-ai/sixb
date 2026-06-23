import type { TeamleaderApiErrorItem } from "./types"

export class TeamleaderApiError extends Error {
  readonly name = "TeamleaderApiError"

  constructor(
    readonly status: number,
    readonly errors: readonly TeamleaderApiErrorItem[],
    readonly responseBody: unknown
  ) {
    super(formatTeamleaderApiError(status, errors))
  }
}

function formatTeamleaderApiError(
  status: number,
  errors: readonly TeamleaderApiErrorItem[]
): string {
  const title = errors.find((error) => error.title)?.title
  return title
    ? `[SixbTeamleader] API request failed with ${status}: ${title}`
    : `[SixbTeamleader] API request failed with ${status}.`
}
