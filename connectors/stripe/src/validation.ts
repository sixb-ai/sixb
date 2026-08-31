interface StripeCursorOptions {
  readonly ending_before?: string
  readonly limit?: number
  readonly starting_after?: string
}

export function stripeId(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`[SixbStripe] ${label} must not be empty.`)
  }
  return value
}

export function assertCursorOptions(options: StripeCursorOptions | undefined): void {
  if (options?.starting_after && options.ending_before) {
    throw new Error("[SixbStripe] starting_after and ending_before are mutually exclusive.")
  }
  assertPageLimit(options?.limit)
}

export function assertPageLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new Error("[SixbStripe] limit must be an integer between 1 and 100.")
  }
}
