/** Map calendar labels selected in the browser to the UTC buckets used by accounting storage. */
export function utcAccountingRangeForCalendarDays(
  from: Date,
  through: Date
): { readonly from: string; readonly to: string } {
  return {
    from: utcCalendarDayStart(from).toISOString(),
    to: nextUtcCalendarDayStart(through).toISOString(),
  }
}

function utcCalendarDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
}

function nextUtcCalendarDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate() + 1))
}
