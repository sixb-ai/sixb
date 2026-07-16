import type { PennylaneCursorOptions } from "./types"

export function pathId(value: number, field: string): string {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`[SixbPennylane] ${field} must be a positive safe integer.`)
  }

  return String(value)
}

export function assertCursorOptions(
  options: PennylaneCursorOptions | undefined,
  maxLimit: number
): void {
  if (options?.limit !== undefined) {
    assertLimit(options.limit, maxLimit)
  }

  if (options?.cursor !== undefined && !options.cursor.trim()) {
    throw new Error("[SixbPennylane] cursor must not be empty when provided.")
  }
}

export function assertLimit(limit: number, maxLimit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new Error(`[SixbPennylane] limit must be an integer between 1 and ${maxLimit}.`)
  }
}
