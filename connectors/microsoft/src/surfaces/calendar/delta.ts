import { MicrosoftConfigurationError, MicrosoftProtocolError } from "../../errors"
import { isRecord } from "../../guards"
import type { MicrosoftHttp } from "../../http"
import { page } from "../../pagination"
import type { CalendarDeltaOptions, CalendarDeltaPage } from "../../types/calendar"
import { graphUrl, httpsUrl } from "../../validation"
import { calendarHeaders, mailboxPath, timeRange } from "./common"

export interface CalendarDeltaResource {
  /** Graph v1.0: primary calendar only, within a fixed date range. */
  list(mailbox: string, options: CalendarDeltaOptions): Promise<CalendarDeltaPage>
  pages(mailbox: string, options: CalendarDeltaOptions): AsyncIterable<CalendarDeltaPage>
}
function path(mailbox: string, options: CalendarDeltaOptions): string {
  const base = mailboxPath(mailbox)
  // Reject unsupported options even from JavaScript callers; do not silently broaden a sync.
  for (const key of ["calendarId", "select", "expand", "filter", "orderBy", "search", "top"]) {
    if (key in options)
      throw new MicrosoftConfigurationError(`Calendar delta does not support ${key}.`)
  }
  if (options.cursor !== undefined) {
    if (options.startDateTime !== undefined || options.endDateTime !== undefined)
      throw new MicrosoftConfigurationError(
        "A calendar delta cursor cannot be combined with a new date range."
      )
    return graphUrl(httpsUrl(options.cursor).href)
  }
  return `${base}/calendarView/delta?${timeRange(options.startDateTime, options.endDateTime)}`
}
export function calendarDeltaResource(http: MicrosoftHttp): CalendarDeltaResource {
  const list = async (
    mailbox: string,
    options: CalendarDeltaOptions
  ): Promise<CalendarDeltaPage> => {
    const result = await http.json(path(mailbox, options), {
      headers: calendarHeaders(options),
      signal: options.signal,
    })
    page(result)
    if (!isRecord(result)) throw new MicrosoftProtocolError("Invalid calendar delta response.")
    const next = result["@odata.nextLink"]
    const delta = result["@odata.deltaLink"]
    if (
      (next !== undefined) === (delta !== undefined) ||
      (delta !== undefined && (typeof delta !== "string" || !delta))
    )
      throw new MicrosoftProtocolError(
        "Calendar delta must return exactly one nextLink or deltaLink."
      )
    graphUrl(httpsUrl(String(next ?? delta)).href)
    return result as unknown as CalendarDeltaPage
  }
  return {
    list,
    async *pages(mailbox, options) {
      const visited = new Set<string>()
      let current = options
      for (;;) {
        const url = graphUrl(path(mailbox, current))
        if (visited.has(url))
          throw new MicrosoftProtocolError("Calendar delta repeated a nextLink.")
        visited.add(url)
        const result = await list(mailbox, current)
        yield result
        const cursor = result["@odata.nextLink"]
        if (!cursor) return
        current = {
          cursor,
          signal: options.signal,
          timeZone: options.timeZone,
          pageSize: options.pageSize,
        }
      }
    },
  }
}
