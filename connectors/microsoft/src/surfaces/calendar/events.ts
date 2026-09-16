import { MicrosoftConfigurationError, MicrosoftProtocolError } from "../../errors"
import { checkEmpty, type MicrosoftHttp, readJson } from "../../http"
import { allPages, page } from "../../pagination"
import type {
  CalendarActionResult,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventUpdate,
  CalendarForwardInput,
  CalendarGetOptions,
  CalendarListOptions,
  CalendarProposalInput,
  CalendarRequestOptions,
  CalendarResponseInput,
  CalendarViewOptions,
} from "../../types/calendar"
import type { GraphPage } from "../../types/common"
import { nonEmpty, resource } from "../../validation"
import {
  calendarHeaders,
  calendarPath,
  calendarQuery,
  dateTime,
  eventPath,
  mutation,
  timeRange,
  validateEvent,
} from "./common"

export interface CalendarEventsResource {
  /** Single events and series masters; use view for expanded occurrences. */
  list(
    mailbox: string,
    options?: CalendarListOptions & { readonly calendarId?: string }
  ): Promise<GraphPage<CalendarEvent>>
  listAll(
    mailbox: string,
    options?: CalendarListOptions & { readonly calendarId?: string }
  ): AsyncIterable<CalendarEvent>
  get(mailbox: string, id: string, options?: CalendarGetOptions): Promise<CalendarEvent>
  /** Creates an appointment, or sends invitations when attendees are supplied. */
  create(
    mailbox: string,
    input: CalendarEventInput,
    options?: CalendarRequestOptions & { readonly calendarId?: string }
  ): Promise<CalendarEvent>
  /** Updating a series master can send multiple meeting updates. */
  update(
    mailbox: string,
    id: string,
    input: CalendarEventUpdate,
    options?: CalendarRequestOptions
  ): Promise<CalendarEvent>
  /** Deleting an organizer's meeting sends cancellation messages. */
  delete(mailbox: string, id: string, options?: CalendarRequestOptions): Promise<void>
  instances(
    mailbox: string,
    seriesId: string,
    options: Omit<CalendarViewOptions, "calendarId">
  ): Promise<GraphPage<CalendarEvent>>
  allInstances(
    mailbox: string,
    seriesId: string,
    options: Omit<CalendarViewOptions, "calendarId">
  ): AsyncIterable<CalendarEvent>
  accept(
    mailbox: string,
    id: string,
    input?: CalendarResponseInput,
    options?: CalendarRequestOptions
  ): Promise<CalendarActionResult>
  tentativelyAccept(
    mailbox: string,
    id: string,
    input?: CalendarProposalInput,
    options?: CalendarRequestOptions
  ): Promise<CalendarActionResult>
  decline(
    mailbox: string,
    id: string,
    input?: CalendarProposalInput,
    options?: CalendarRequestOptions
  ): Promise<CalendarActionResult>
  forward(
    mailbox: string,
    id: string,
    input: CalendarForwardInput,
    options?: CalendarRequestOptions
  ): Promise<CalendarActionResult>
  /** Organizer only. Also accepts an occurrence ID to cancel one instance. */
  cancel(
    mailbox: string,
    id: string,
    input?: { readonly comment?: string },
    options?: CalendarRequestOptions
  ): Promise<CalendarActionResult>
}
export function rangeQuery(options: Omit<CalendarViewOptions, "calendarId">): string {
  const params = timeRange(options.startDateTime, options.endDateTime)
  if (options.top !== undefined && options.top > 1000)
    throw new MicrosoftConfigurationError("Calendar view top cannot exceed 1000.")
  for (const [key, value] of new URLSearchParams(calendarQuery(options).slice(1)))
    params.set(key, value)
  return `?${params}`
}
export function eventsResource(http: MicrosoftHttp): CalendarEventsResource {
  const list = async (
    path: string,
    options?: CalendarRequestOptions
  ): Promise<GraphPage<CalendarEvent>> =>
    page(await http.json(path, { headers: calendarHeaders(options), signal: options?.signal }))
  const responseInput = (input: CalendarProposalInput = {}) => {
    if (input.proposedNewTime) {
      if (input.sendResponse === false)
        throw new MicrosoftConfigurationError("A new time proposal requires sendResponse.")
      dateTime(input.proposedNewTime.start)
      dateTime(input.proposedNewTime.end)
      validateEvent(input.proposedNewTime)
    }
    return input
  }
  const action = async (
    mailbox: string,
    id: string,
    name: string,
    body: unknown,
    options?: CalendarRequestOptions
  ): Promise<CalendarActionResult> => {
    const response = await mutation(http, `${eventPath(mailbox, id)}/${name}`, {
      method: "POST",
      body,
      headers: calendarHeaders(options),
      signal: options?.signal,
    })
    if (!response.ok) await readJson(response)
    if (response.status !== 202) {
      await response.body?.cancel()
      throw new MicrosoftProtocolError("Expected 202 Accepted for a calendar action.")
    }
    await response.body?.cancel()
    const requestId = response.headers.get("request-id")
    return { status: "accepted", ...(requestId ? { requestId } : {}) }
  }
  return {
    list: (mailbox, options) =>
      list(
        `${calendarPath(mailbox, options?.calendarId)}/events${calendarQuery(options)}`,
        options
      ),
    listAll: (mailbox, options) =>
      allPages(
        http,
        `${calendarPath(mailbox, options?.calendarId)}/events${calendarQuery(options)}`,
        options,
        calendarHeaders(options)
      ),
    async get(mailbox, id, options) {
      return resource(
        await http.json(`${eventPath(mailbox, id)}${calendarQuery(options)}`, {
          headers: calendarHeaders(options),
          signal: options?.signal,
        })
      )
    },
    async create(mailbox, input, options) {
      dateTime(input.start)
      dateTime(input.end)
      validateEvent(input)
      if (input.transactionId !== undefined) nonEmpty(input.transactionId, "transactionId")
      return resource(
        await readJson(
          await mutation(http, `${calendarPath(mailbox, options?.calendarId)}/events`, {
            method: "POST",
            body: input,
            headers: calendarHeaders(options),
            signal: options?.signal,
          })
        )
      )
    },
    async update(mailbox, id, input, options) {
      validateEvent(input)
      return resource(
        await readJson(
          await mutation(http, eventPath(mailbox, id), {
            method: "PATCH",
            body: input,
            headers: calendarHeaders(options),
            signal: options?.signal,
          })
        )
      )
    },
    async delete(mailbox, id, options) {
      await checkEmpty(
        await mutation(http, eventPath(mailbox, id), {
          method: "DELETE",
          headers: calendarHeaders(options),
          signal: options?.signal,
        })
      )
    },
    instances: (mailbox, id, options) =>
      list(`${eventPath(mailbox, id)}/instances${rangeQuery(options)}`, options),
    allInstances: (mailbox, id, options) =>
      allPages(
        http,
        `${eventPath(mailbox, id)}/instances${rangeQuery(options)}`,
        options,
        calendarHeaders(options)
      ),
    accept: (mailbox, id, input = {}, options) => action(mailbox, id, "accept", input, options),
    tentativelyAccept: (mailbox, id, input, options) =>
      action(mailbox, id, "tentativelyAccept", responseInput(input), options),
    decline: (mailbox, id, input, options) =>
      action(mailbox, id, "decline", responseInput(input), options),
    forward(mailbox, id, input, options) {
      if (!input.toRecipients.length)
        throw new MicrosoftConfigurationError("Forwarding requires at least one recipient.")
      for (const recipient of input.toRecipients)
        nonEmpty(recipient.emailAddress.address ?? "", "recipient address")
      return action(mailbox, id, "forward", input, options)
    },
    cancel: (mailbox, id, input = {}, options) => action(mailbox, id, "cancel", input, options),
  }
}
