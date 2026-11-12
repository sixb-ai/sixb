import type { CtmId } from "./types"

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * An ID as a path segment. `Failure` lets the account ID, which is configuration, fail as a
 * `CtmConfigurationError` while a method's own argument fails as a plain `Error`.
 */
export function pathId(
  value: CtmId,
  field: string,
  Failure: new (message: string) => Error = Error
): string {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) {
      throw new Failure(`[SixbCtm] ${field} must be a positive integer.`)
    }

    return String(value)
  }

  if (typeof value !== "string" || !value.trim()) {
    throw new Failure(`[SixbCtm] ${field} must not be empty.`)
  }

  return encodeURIComponent(value.trim())
}

export function assertPositiveInteger(value: number | undefined, field: string): void {
  if (value === undefined) {
    return
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`[SixbCtm] ${field} must be a positive integer.`)
  }
}

export function assertDate(value: string, field: string): void {
  if (typeof value !== "string" || !DATE.test(value)) {
    throw new Error(`[SixbCtm] ${field} must be a date written YYYY-MM-DD.`)
  }
}

/** Agent analytics take their window in whole seconds since the epoch, end after start. */
export function assertTimeWindow(startTime: number, endTime: number): void {
  for (const [field, value] of [
    ["startTime", startTime],
    ["endTime", endTime],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`[SixbCtm] ${field} must be whole seconds since the epoch.`)
    }
  }

  if (endTime <= startTime) {
    throw new Error("[SixbCtm] endTime must be after startTime.")
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[SixbCtm] ${field} must not be empty.`)
  }
}
