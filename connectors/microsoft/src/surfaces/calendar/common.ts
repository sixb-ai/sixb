import type { RestRequestInit } from "@sixb/connector-rest"
import { MicrosoftConfigurationError } from "../../errors"
import type { MicrosoftHttp } from "../../http"
import type {
  CalendarDateTime,
  CalendarEventUpdate,
  CalendarGetOptions,
  CalendarListOptions,
  CalendarRequestOptions,
} from "../../types/calendar"
import { nonEmpty, query, segment } from "../../validation"

export const mailboxPath = (mailbox: string) => `users/${segment(mailbox, "mailbox")}`
export const calendarPath = (mailbox: string, id?: string) =>
  id === undefined
    ? `${mailboxPath(mailbox)}/calendar`
    : `${mailboxPath(mailbox)}/calendars/${segment(id, "calendarId")}`
export const eventPath = (mailbox: string, id: string) =>
  `${mailboxPath(mailbox)}/events/${segment(id, "eventId")}`
export function calendarHeaders(
  options?: CalendarRequestOptions & { readonly pageSize?: number }
): HeadersInit {
  const preferences = ['IdType="ImmutableId"']
  if (options?.timeZone !== undefined) {
    nonEmpty(options.timeZone, "timeZone")
    if (/["\\\r\n]/.test(options.timeZone))
      throw new MicrosoftConfigurationError(
        "timeZone cannot contain quotes, backslashes or line breaks."
      )
    preferences.push(`outlook.timezone="${options.timeZone}"`)
  }
  if (options?.pageSize !== undefined) {
    if (!Number.isSafeInteger(options.pageSize) || options.pageSize <= 0)
      throw new MicrosoftConfigurationError("pageSize must be a positive integer.")
    preferences.push(`odata.maxpagesize=${options.pageSize}`)
  }
  return { Prefer: preferences.join(", ") }
}
export function calendarQuery(options?: CalendarGetOptions | CalendarListOptions): string {
  const params = new URLSearchParams(query(options).slice(1))
  if (options && "filter" in options && options.filter !== undefined)
    params.set("$filter", nonEmpty(options.filter, "filter"))
  return params.size ? `?${params}` : ""
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}
export function timeRange(start: string, end: string): URLSearchParams {
  const timestamp = (value: string) => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !validDate(value.slice(0, 10)) ||
      !Number.isFinite(Date.parse(value))
    )
      throw new MicrosoftConfigurationError(
        "Calendar ranges require ISO timestamps with Z or an explicit offset."
      )
    return Date.parse(value)
  }
  if (timestamp(start) >= timestamp(end))
    throw new MicrosoftConfigurationError("Calendar range end must be after start.")
  return new URLSearchParams({ startDateTime: start, endDateTime: end })
}
export function dateTime(value: CalendarDateTime): void {
  if (!value || typeof value !== "object")
    throw new MicrosoftConfigurationError("Expected dateTime and timeZone.")
  nonEmpty(value.timeZone, "timeZone")
  // Keep the local time and zone intact: JS Date would silently apply the machine's zone.
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/.test(value.dateTime) ||
    !validDate(value.dateTime.slice(0, 10)) ||
    !Number.isFinite(Date.parse(`${value.dateTime}Z`))
  )
    throw new MicrosoftConfigurationError(
      "dateTime must be a local ISO date-time without an offset; supply timeZone separately."
    )
}
export function validateEvent(input: CalendarEventUpdate): void {
  if (input.start) dateTime(input.start)
  if (input.end) dateTime(input.end)
  if (
    input.start &&
    input.end &&
    input.start.timeZone === input.end.timeZone &&
    Date.parse(`${input.start.dateTime}Z`) >= Date.parse(`${input.end.dateTime}Z`)
  )
    throw new MicrosoftConfigurationError("Event end must be after start.")
  if (input.isAllDay) {
    if (
      !input.start ||
      !input.end ||
      input.start.timeZone !== input.end.timeZone ||
      ![input.start, input.end].every((value) => /T00:00:00(?:\.0+)?$/.test(value.dateTime))
    )
      throw new MicrosoftConfigurationError(
        "All-day writes require start and end at midnight in the same time zone."
      )
  }
  if (
    input.reminderMinutesBeforeStart !== undefined &&
    (!Number.isSafeInteger(input.reminderMinutesBeforeStart) ||
      input.reminderMinutesBeforeStart < 0)
  )
    throw new MicrosoftConfigurationError(
      "reminderMinutesBeforeStart must be a nonnegative integer."
    )
  for (const attendee of input.attendees ?? [])
    nonEmpty(attendee.emailAddress.address ?? "", "attendee address")
  if (input.recurrence) {
    const { pattern, range } = input.recurrence
    if (!Number.isSafeInteger(pattern.interval) || pattern.interval <= 0)
      throw new MicrosoftConfigurationError("Recurrence interval must be a positive integer.")
    const date = (value: string | undefined) => typeof value === "string" && validDate(value)
    if (
      !date(range.startDate) ||
      (range.type === "endDate" && (!date(range.endDate) || range.endDate! < range.startDate)) ||
      (range.type === "numbered" &&
        (!Number.isSafeInteger(range.numberOfOccurrences) || range.numberOfOccurrences! <= 0))
    )
      throw new MicrosoftConfigurationError("Invalid recurrence date range or occurrence count.")
    if (
      ["weekly", "relativeMonthly", "relativeYearly"].includes(pattern.type) &&
      !pattern.daysOfWeek?.length
    )
      throw new MicrosoftConfigurationError("This recurrence pattern requires daysOfWeek.")
    if (pattern.type === "weekly" && !pattern.firstDayOfWeek)
      throw new MicrosoftConfigurationError("Weekly recurrence requires firstDayOfWeek.")
    if (
      ["absoluteMonthly", "absoluteYearly"].includes(pattern.type) &&
      (!Number.isInteger(pattern.dayOfMonth) || pattern.dayOfMonth! < 1 || pattern.dayOfMonth! > 31)
    )
      throw new MicrosoftConfigurationError(
        "This recurrence pattern requires dayOfMonth between 1 and 31."
      )
    if (
      ["absoluteYearly", "relativeYearly"].includes(pattern.type) &&
      (!Number.isInteger(pattern.month) || pattern.month! < 1 || pattern.month! > 12)
    )
      throw new MicrosoftConfigurationError("Yearly recurrence requires month between 1 and 12.")
  }
}
/** A transport interruption cannot establish whether a calendar mutation took effect. */
export class MicrosoftCalendarMutationError extends Error {
  readonly outcomeUnknown = true
  constructor(cause: unknown) {
    super(
      "[SixbMicrosoft] Calendar mutation interrupted; reconcile the event before repeating the operation.",
      { cause }
    )
    this.name = "MicrosoftCalendarMutationError"
  }
}
export async function mutation(
  http: MicrosoftHttp,
  path: string,
  init: RestRequestInit
): Promise<Response> {
  try {
    return await http.request(path, init)
  } catch (cause) {
    throw new MicrosoftCalendarMutationError(cause)
  }
}
