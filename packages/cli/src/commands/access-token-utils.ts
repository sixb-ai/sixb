import type { SixbApiClientConfig } from "../lib/api-client"
import { parseDurationMs } from "../lib/duration"

/**
 * The API creates tokens only for a signed-in session, never for another access token, so say how
 * to sign in rather than relaying its refusal.
 */
export function assertSignedIn(config: SixbApiClientConfig): void {
  if (config.tokenSource === "session") return
  throw new Error(
    `[SixbCLI] Creating a token requires signing in; an access token cannot create another token. Run \`sixb login ${config.apiUrl}\`, then create the token from that profile.`
  )
}

export interface ExpirationOptions {
  readonly expiresAt?: string
  readonly expiresIn?: string
}

export function resolveExpiration(options: ExpirationOptions): string {
  if (options.expiresAt?.trim()) {
    const date = new Date(options.expiresAt)
    if (Number.isNaN(date.getTime())) {
      throw new Error("[SixbCLI] --expires-at must be a valid date or ISO timestamp.")
    }
    return date.toISOString()
  }

  const duration = parseDurationMs(options.expiresIn ?? "90d", "--expires-in")
  return new Date(Date.now() + duration).toISOString()
}

export function normalizeGroupIds(values: readonly string[] | undefined): string[] {
  const groupIds: string[] = []
  for (const value of values ?? []) {
    for (const groupId of value.split(",")) {
      const trimmed = groupId.trim()
      if (trimmed && !groupIds.includes(trimmed)) {
        groupIds.push(trimmed)
      }
    }
  }

  return groupIds
}

export function formatGroups(groupIds: readonly string[] | undefined): string {
  if (!groupIds) return "Inherited"
  if (groupIds.length === 0) return "None"
  return groupIds.join(",")
}

export function formatDate(value: string | undefined): string {
  if (!value) return "Never"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().replace("T", " ").slice(0, 16)
}
