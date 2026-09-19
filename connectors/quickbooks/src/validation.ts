export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[SixbQuickBooks] ${field} must be a non-empty string.`)
  }
}

export function realmId(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("[SixbQuickBooks] realmId must be a numeric company ID.")
  }
  return value
}
