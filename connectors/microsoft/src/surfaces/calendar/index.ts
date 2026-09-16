import { MicrosoftConfigurationError, MicrosoftProtocolError } from "../../errors"
import { isRecord } from "../../guards"
import type { MicrosoftHttp } from "../../http"
import type {
  CalendarRequestOptions,
  CalendarSchedule,
  CalendarScheduleInput,
} from "../../types/calendar"
import type { GraphPage } from "../../types/common"
import { nonEmpty } from "../../validation"
import { type CalendarAttachmentsResource, calendarAttachmentsResource } from "./attachments"
import { type CalendarsResource, calendarsResource } from "./calendars"
import { calendarHeaders, calendarPath, dateTime, validateEvent } from "./common"
import { type CalendarEventsResource, eventsResource } from "./events"
import { type CalendarViewResource, viewResource } from "./view"

export interface CalendarSurface {
  readonly calendars: CalendarsResource
  readonly events: CalendarEventsResource
  readonly view: CalendarViewResource
  readonly attachments: CalendarAttachmentsResource
  getSchedule(
    mailbox: string,
    input: CalendarScheduleInput,
    options?: CalendarRequestOptions
  ): Promise<GraphPage<CalendarSchedule>>
}
export function calendarSurface(http: MicrosoftHttp): CalendarSurface {
  return {
    calendars: calendarsResource(http),
    events: eventsResource(http),
    view: viewResource(http),
    attachments: calendarAttachmentsResource(http),
    async getSchedule(mailbox, input, options) {
      if (!input.schedules.length || input.schedules.length > 20)
        throw new MicrosoftConfigurationError("getSchedule requires 1–20 schedules per request.")
      for (const address of input.schedules) nonEmpty(address, "schedule address")
      dateTime(input.startTime)
      dateTime(input.endTime)
      validateEvent({ start: input.startTime, end: input.endTime })
      if (
        input.startTime.timeZone === input.endTime.timeZone &&
        Date.parse(`${input.endTime.dateTime}Z`) - Date.parse(`${input.startTime.dateTime}Z`) >=
          62 * 86400000
      )
        throw new MicrosoftConfigurationError("getSchedule requires a period shorter than 62 days.")
      const interval = input.availabilityViewInterval
      if (
        interval !== undefined &&
        (!Number.isSafeInteger(interval) || interval < 5 || interval > 1440)
      )
        throw new MicrosoftConfigurationError(
          "availabilityViewInterval must be an integer between 5 and 1440 minutes."
        )
      const result = await http.json(`${calendarPath(mailbox)}/getSchedule`, {
        method: "POST",
        body: input,
        headers: calendarHeaders(options),
        signal: options?.signal,
      })
      // These records use scheduleId, not the id required by Graph entity pagination.
      if (
        !isRecord(result) ||
        !Array.isArray(result.value) ||
        result.value.some(
          (item) => !isRecord(item) || typeof item.scheduleId !== "string" || !item.scheduleId
        )
      )
        throw new MicrosoftProtocolError("Invalid calendar schedule response.")
      return result as unknown as GraphPage<CalendarSchedule>
    },
  }
}
