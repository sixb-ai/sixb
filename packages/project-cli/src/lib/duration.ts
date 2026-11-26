import { parseDuration } from "@sixb/core/internal/runtime"

/** A duration flag such as 30m, 12h, 7d, 4w or 1y, in milliseconds. */
export function parseDurationMs(value: string, flag: string): number {
  const durationMs = parseDuration(value)
  if (durationMs === null) {
    throw new Error(`[SixbCLI] Use ${flag} like 30d, 12h, 4w, or 1y.`)
  }

  return durationMs
}
