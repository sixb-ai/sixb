import type {
  LinkedinDate,
  LinkedinOffsetOptions,
  LinkedinOffsetPage,
  LinkedinOptionalDateRange,
  LinkedinPaging,
  LinkedinTimeIntervals,
  LinkedinTimeRange,
} from "../types/common"

export interface ElementsResponse<TItem> {
  readonly elements?: readonly TItem[]
  readonly paging?: LinkedinPaging
}

export function offsetPage<TItem>(
  response: ElementsResponse<TItem>,
  options?: LinkedinOffsetOptions
): LinkedinOffsetPage<TItem> {
  return {
    items: response.elements ?? [],
    paging: response.paging ?? {
      start: options?.start ?? 0,
      count: response.elements?.length ?? 0,
    },
  }
}

export function assertOptionalDateRange(
  range: LinkedinOptionalDateRange | undefined,
  field = "dateRange"
): void {
  if (!range) return
  const start = range.start ? utcDate(range.start, `${field}.start`) : undefined
  const end = range.end ? utcDate(range.end, `${field}.end`) : undefined
  if (start !== undefined && end !== undefined && start >= end) {
    throw new Error(`[SixbLinkedin] ${field}.start must be before ${field}.end.`)
  }
}

export function assertTimeIntervals(value: LinkedinTimeIntervals | undefined): void {
  if (!value) return
  assertTimeRange(value.timeRange, "timeIntervals.timeRange")
}

export function assertTimeRange(value: LinkedinTimeRange | undefined, field = "timeRange"): void {
  if (!value) return
  for (const [name, timestamp] of Object.entries(value)) {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error(`[SixbLinkedin] ${field}.${name} must be a non-negative epoch timestamp.`)
    }
  }
  if (value.start !== undefined && value.end !== undefined && value.start >= value.end) {
    throw new Error(`[SixbLinkedin] ${field}.start must be before ${field}.end.`)
  }
}

function utcDate(value: LinkedinDate, field: string): number {
  const timestamp = Date.UTC(value.year, value.month - 1, value.day)
  const resolved = new Date(timestamp)
  if (
    !Number.isInteger(value.year) ||
    !Number.isInteger(value.month) ||
    !Number.isInteger(value.day) ||
    resolved.getUTCFullYear() !== value.year ||
    resolved.getUTCMonth() + 1 !== value.month ||
    resolved.getUTCDate() !== value.day
  ) {
    throw new Error(`[SixbLinkedin] ${field} must be a valid UTC calendar date.`)
  }
  return timestamp
}
