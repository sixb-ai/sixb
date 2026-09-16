import type { MicrosoftHttp } from "../../http"
import { allPages, page } from "../../pagination"
import type { CalendarEvent, CalendarViewOptions } from "../../types/calendar"
import type { GraphPage } from "../../types/common"
import { calendarHeaders, calendarPath } from "./common"
import { type CalendarDeltaResource, calendarDeltaResource } from "./delta"
import { rangeQuery } from "./events"

export interface CalendarViewResource {
  readonly delta: CalendarDeltaResource
  list(mailbox: string, options: CalendarViewOptions): Promise<GraphPage<CalendarEvent>>
  listAll(mailbox: string, options: CalendarViewOptions): AsyncIterable<CalendarEvent>
}
export function viewResource(http: MicrosoftHttp): CalendarViewResource {
  const path = (mailbox: string, options: CalendarViewOptions) =>
    `${calendarPath(mailbox, options.calendarId)}/calendarView${rangeQuery(options)}`
  return {
    delta: calendarDeltaResource(http),
    async list(mailbox, options) {
      return page(
        await http.json(path(mailbox, options), {
          headers: calendarHeaders(options),
          signal: options.signal,
        })
      )
    },
    listAll: (mailbox, options) =>
      allPages(http, path(mailbox, options), options, calendarHeaders(options)),
  }
}
