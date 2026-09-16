import { checkEmpty, type MicrosoftHttp, readJson } from "../../http"
import { allPages, page } from "../../pagination"
import type { Calendar, CalendarUpdate } from "../../types/calendar"
import type { GraphPage, ListOptions, RequestOptions, SelectOptions } from "../../types/common"
import { nonEmpty, query, resource } from "../../validation"
import { calendarPath, mailboxPath, mutation } from "./common"

export interface CalendarsResource {
  list(mailbox: string, options?: ListOptions): Promise<GraphPage<Calendar>>
  listAll(mailbox: string, options?: ListOptions): AsyncIterable<Calendar>
  get(mailbox: string, id: string, options?: SelectOptions): Promise<Calendar>
  getDefault(mailbox: string, options?: SelectOptions): Promise<Calendar>
  create(mailbox: string, name: string, options?: RequestOptions): Promise<Calendar>
  update(
    mailbox: string,
    id: string,
    input: CalendarUpdate,
    options?: RequestOptions
  ): Promise<Calendar>
  delete(mailbox: string, id: string, options?: RequestOptions): Promise<void>
}
export function calendarsResource(http: MicrosoftHttp): CalendarsResource {
  const get = async (path: string, options?: SelectOptions): Promise<Calendar> =>
    resource(await http.json(`${path}${query(options)}`, { signal: options?.signal }))
  return {
    async list(mailbox, options) {
      return page(
        await http.json(`${mailboxPath(mailbox)}/calendars${query(options)}`, {
          signal: options?.signal,
        })
      )
    },
    listAll(mailbox, options) {
      return allPages(http, `${mailboxPath(mailbox)}/calendars${query(options)}`, options)
    },
    get: (mailbox, id, options) => get(calendarPath(mailbox, id), options),
    getDefault: (mailbox, options) => get(calendarPath(mailbox), options),
    async create(mailbox, name, options) {
      return resource(
        await readJson(
          await mutation(http, `${mailboxPath(mailbox)}/calendars`, {
            method: "POST",
            body: { name: nonEmpty(name, "calendar name") },
            signal: options?.signal,
          })
        )
      )
    },
    async update(mailbox, id, input, options) {
      if (input.name !== undefined) nonEmpty(input.name, "calendar name")
      return resource(
        await readJson(
          await mutation(http, calendarPath(mailbox, id), {
            method: "PATCH",
            body: input,
            signal: options?.signal,
          })
        )
      )
    },
    async delete(mailbox, id, options) {
      await checkEmpty(
        await mutation(http, calendarPath(mailbox, id), {
          method: "DELETE",
          signal: options?.signal,
        })
      )
    },
  }
}
