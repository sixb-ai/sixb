import type { AceIotTimeInput, AceIotTimestamp } from "./types"

/**
 * Matches an ACE timestamp that carries no zone designator, in either shape ACE emits: the ISO
 * `2026-08-07T16:25:00[.627593]` used by samples and `created`/`updated`, and the space-separated
 * `2027-03-04 19:34:54.114795` used by `device_token_expires`.
 */
const NAIVE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/

/**
 * Parse an ACE timestamp as the UTC instant it represents.
 *
 * ACE returns timestamps with no zone designator even though they are UTC, so `new Date(value)`
 * reads them as local time and shifts every sample by the host's offset — silently, and only for
 * hosts that are not on UTC. Sub-second digits beyond milliseconds are truncated, as `Date` has no
 * room for them.
 *
 * Values that already carry a zone (`Z` or `±HH:MM`) are parsed as-is.
 */
export function parseAceIotTimestamp(value: AceIotTimestamp): Date {
  const parsed = new Date(normalizeAceIotTimestamp(value))
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`[SixbAceIot] Could not parse "${value}" as a timestamp.`)
  }

  return parsed
}

/** The same normalization as `parseAceIotTimestamp`, kept as a string. */
export function normalizeAceIotTimestamp(value: AceIotTimestamp): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("[SixbAceIot] A timestamp must be a non-empty string.")
  }

  const naive = NAIVE_TIMESTAMP.exec(value.trim())
  return naive ? `${naive[1]}T${naive[2]}Z` : value.trim()
}

/**
 * Serialize a `start_time`/`end_time` query value. A `Date` becomes a UTC ISO string; a string is
 * normalized the same way responses are, so a naive timestamp read off one response can be handed
 * straight back as a query bound without shifting by the host's offset.
 */
export function toAceIotQueryTime(value: AceIotTimeInput, field: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`[SixbAceIot] ${field} must be a valid Date.`)
    }
    return value.toISOString()
  }

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[SixbAceIot] ${field} must be a Date or a non-empty string.`)
  }

  return normalizeAceIotTimestamp(value)
}
