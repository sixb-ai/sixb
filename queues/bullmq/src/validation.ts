import { SixbError } from "@sixb/core/errors"

export function assertNonEmpty(value: string, fieldName: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SixbError("runtime.invalid_input", `[Sixb] Queue ${fieldName} must not be empty`)
  }
}

export function assertPositiveNumber(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SixbError("runtime.invalid_input", `[Sixb] Queue ${fieldName} must be greater than 0`)
  }
}

export function parseTimestamp(value: string, fieldName: string): number {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) {
    throw new SixbError(
      "runtime.invalid_input",
      `[Sixb] Queue ${fieldName} must be a valid timestamp`
    )
  }
  return timestamp
}
