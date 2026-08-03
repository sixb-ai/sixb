import { SixbError } from "../../errors"

export function assertNonblank(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SixbError("ontology.invalid_value", `[Sixb] ${label} must be nonblank.`)
  }
}

export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SixbError(
      "ontology.invalid_value",
      `[Sixb] ${label} must be a positive safe integer.`
    )
  }
}

export function assertNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SixbError(
      "ontology.invalid_value",
      `[Sixb] ${label} must be a nonnegative safe integer.`
    )
  }
}

export function assertTimestamp(value: string, label: string, canonical = true): number {
  const milliseconds = Date.parse(value)
  if (
    !Number.isFinite(milliseconds) ||
    (canonical && new Date(milliseconds).toISOString() !== value)
  ) {
    throw new SixbError(
      "ontology.invalid_value",
      `[Sixb] ${label} must be ${canonical ? "a canonical UTC" : "a valid"} timestamp.`
    )
  }
  return milliseconds
}

export function invalidCorrelation(message: string): never {
  throw new SixbError("ontology.invalid_value", `[Sixb] ${message}`)
}
