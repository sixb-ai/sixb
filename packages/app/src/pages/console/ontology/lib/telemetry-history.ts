import type { GetTelemetryHistoryOptions } from "@sixb/client/hooks"

export interface TelemetryHistoryBounds {
  startMs: number
  endMs: number
}

function parseDurationMs(input: string | undefined): number | null {
  if (!input) return null

  const match = /^(\d+)(ms|s|m|h|d)$/.exec(input.trim())
  if (!match) return null

  const value = Number.parseInt(match[1], 10)
  const unit = match[2]

  if (unit === "ms") return value
  if (unit === "s") return value * 1000
  if (unit === "m") return value * 60_000
  if (unit === "h") return value * 3_600_000
  if (unit === "d") return value * 86_400_000
  return null
}

function getDateMs(value: Date | string | undefined): number | null {
  if (value === undefined) return null

  const date = typeof value === "string" ? new Date(value) : value
  const timestamp = date.getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

function getTimestampMs(timestamp: string): number {
  const value = new Date(timestamp).getTime()
  return Number.isFinite(value) ? value : 0
}

export function getHistoryBounds(
  query: GetTelemetryHistoryOptions["query"] | undefined,
  nowMs = Date.now()
): TelemetryHistoryBounds {
  const endMs = getDateMs(query?.to) ?? nowMs
  const duration = parseDurationMs(query?.range)
  return {
    startMs: getDateMs(query?.from) ?? endMs - (duration ?? 7 * 86_400_000),
    endMs,
  }
}

export function isSampleInBounds(
  sample: { timestamp: string },
  bounds: TelemetryHistoryBounds
): boolean {
  const timestampMs = getTimestampMs(sample.timestamp)
  return timestampMs >= bounds.startMs && timestampMs <= bounds.endMs
}
