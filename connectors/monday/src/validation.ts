export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
export function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`[SixbMonday] ${field} must not be empty.`)
  return value
}
export function id(value: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    throw new Error("[SixbMonday] IDs must be positive decimal strings.")
  return value
}
export function integer(
  value: number,
  field: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`[SixbMonday] ${field} must be an integer between ${min} and ${max}.`)
  return value
}
export function ids(values: readonly string[], max = 100): string[] {
  integer(values.length, "IDs length", 1, max)
  return values.map(id)
}
export function columnIds(values?: readonly string[]): readonly string[] | undefined {
  for (const value of values ?? []) nonEmpty(value, "column ID")
  return values
}
export function objectResult<T>(value: unknown): T {
  if (!record(value)) throw new Error("[SixbMonday] Invalid object in API response.")
  // The fixed GraphQL selections define wire types. Guard object/list envelopes here.
  return value as T
}
export function entity<T>(value: unknown): T {
  if (!record(value) || typeof value.id !== "string")
    throw new Error("[SixbMonday] Missing or invalid entity in API response.")
  return value as T
}
export function entities<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error("[SixbMonday] Invalid list in API response.")
  return value.map((entry) => entity<T>(entry))
}
export function required<T>(value: T | undefined, kind: string): T {
  if (value === undefined) throw new Error(`[SixbMonday] ${kind} not found or not accessible.`)
  return value
}
