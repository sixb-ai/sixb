const UNIT_MS = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
  y: 365 * 24 * 60 * 60_000,
} as const

/** A duration flag such as 30m, 12h, 7d, 4w or 1y, in milliseconds. */
export function parseDurationMs(value: string, flag: string): number {
  const match = value.trim().match(/^(\d+)(m|h|d|w|y)$/)
  if (!match) {
    throw new Error(`[SixbCLI] Use ${flag} like 30d, 12h, 4w, or 1y.`)
  }

  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]
}
