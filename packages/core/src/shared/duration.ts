const UNIT_MS = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
  y: 365 * 24 * 60 * 60_000,
} as const

/** A duration such as 30m, 12h, 7d, 4w or 1y in milliseconds, or `null` when it is not one. */
export function parseDuration(value: string): number | null {
  const match = value.trim().match(/^(\d+)(m|h|d|w|y)$/)
  if (!match) return null

  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]
}
