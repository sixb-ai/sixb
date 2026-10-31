/** Every query of the Activity page starts with this, so Refresh reloads them together. */
export const activityQueryKey = ["settings-activity"] as const

const dayMs = 86_400_000

/** Rolling ranges ending when chosen. The API reads at most 31 days at once. */
export const activityRanges = [
  { id: "24h", ms: dayMs },
  { id: "7d", ms: 7 * dayMs },
  { id: "30d", ms: 30 * dayMs },
] as const

export type ActivityRange = (typeof activityRanges)[number]["id"]

export function parseActivityRange(value: string | null): ActivityRange {
  return activityRanges.find((range) => range.id === value)?.id ?? "7d"
}

/** A real calendar day as `YYYY-MM-DD`, from 1970 on, or undefined. */
export function parseActivityDay(value: string | null): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined
  }

  const at = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(at) && at >= 0 && utcDay(at) === value ? value : undefined
}

/** The period the page reads: one UTC day when chosen, else the range ending at `end`. */
export function activityPeriod(input: {
  readonly range: ActivityRange
  readonly day: string | undefined
  readonly end: Date
}): { readonly from: string; readonly to: string } {
  if (input.day !== undefined) {
    const from = Date.parse(`${input.day}T00:00:00.000Z`)
    return { from: new Date(from).toISOString(), to: new Date(from + dayMs).toISOString() }
  }

  const span = activityRanges.find((range) => range.id === input.range)?.ms ?? 7 * dayMs
  return {
    from: new Date(input.end.getTime() - span).toISOString(),
    to: input.end.toISOString(),
  }
}

/** The UTC calendar day of an instant, as `YYYY-MM-DD`. */
export function utcDay(at: Date | number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** A year's days in week columns, Sunday first; `null` pads the weeks outside the year. */
export function activityYearGrid(year: number): readonly (string | null)[] {
  const first = Date.UTC(year, 0, 1)
  const end = Date.UTC(year + 1, 0, 1)
  const leading = new Date(first).getUTCDay()
  const length = Math.ceil((leading + (end - first) / dayMs) / 7) * 7

  return Array.from({ length }, (_, index) => {
    const at = first + (index - leading) * dayMs
    return at < first || at >= end ? null : utcDay(at)
  })
}
