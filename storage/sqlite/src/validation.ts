import { materializationConflict } from "@sixb/core/internal/materialization"

export function assertProjectionRunFieldNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw materializationConflict(
      "run-correlation",
      `[SixbSqlite] Projection run ${fieldName} must not be empty.`
    )
  }
}

export function assertProjectionRunCounter(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw materializationConflict(
      "run-correlation",
      `[SixbSqlite] Projection run ${fieldName} must be a non-negative integer.`
    )
  }
}

export function assertOptionalProjectionRunCounter(
  value: number | undefined,
  fieldName: string
): void {
  if (value !== undefined) {
    assertProjectionRunCounter(value, fieldName)
  }
}

export function assertProjectionRunListWindowValue(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw materializationConflict(
      "run-correlation",
      `[SixbSqlite] Projection run list ${fieldName} must be >= 0.`
    )
  }
}
