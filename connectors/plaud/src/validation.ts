export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function nonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`[SixbPlaud] ${label} must not be empty.`)
  return value
}

export function integer(value: number, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`[SixbPlaud] ${label} must be an integer >= ${minimum}.`)
  return value
}

export function signalFor(
  base: AbortSignal,
  request?: AbortSignal,
  timeoutMs = 30_000
): AbortSignal {
  return AbortSignal.any([base, ...(request ? [request] : []), AbortSignal.timeout(timeoutMs)])
}
