import { afterEach, expect, test } from "bun:test"
import {
  type CalendarDeltaOptions,
  type CalendarEventInput,
  MicrosoftCalendarMutationError,
  MicrosoftConfigurationError,
  MicrosoftProtocolError,
} from "../src"
import {
  apiError,
  CONTEXT,
  collect,
  connect,
  GRAPH,
  json,
  mockFetch,
  restoreFetch,
} from "./helpers"

afterEach(restoreFetch)
const mailbox = "user+test@example.com"
const base = `${GRAPH}users/user%2Btest%40example.com`
const range = {
  startDateTime: "2026-11-01T00:00:00-04:00",
  endDateTime: "2026-11-03T00:00:00-05:00",
}
const event: CalendarEventInput = {
  subject: "Review",
  start: { dateTime: "2026-11-01T09:00:00", timeZone: "Eastern Standard Time" },
  end: { dateTime: "2026-11-01T10:00:00", timeZone: "Eastern Standard Time" },
  transactionId: "logical-request-1",
}

test("calendar CRUD targets encoded users and calendar IDs; default is explicit", async () => {
  const requests = mockFetch((r) =>
    r.method === "DELETE"
      ? new Response(null, { status: 204 })
      : json(
          r.url.includes("?") && r.url.includes("/calendars?")
            ? { value: [{ id: "c" }] }
            : { id: "c", name: "Work" }
        )
  )
  const { calendars } = (await connect()).calendar
  expect((await calendars.list(mailbox, { top: 2 })).value).toEqual([{ id: "c" }])
  expect(await collect(calendars.listAll(mailbox, { top: 2 }))).toEqual([{ id: "c" }])
  await calendars.getDefault(mailbox)
  await calendars.get(mailbox, "c/+", { select: ["name"] })
  await calendars.create(mailbox, "Work")
  await calendars.update(mailbox, "c/+", { name: "New name", color: "lightBlue" })
  await calendars.delete(mailbox, "c/+")
  expect(requests.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
    ["GET", new URL(`${base}/calendars`).pathname],
    ["GET", new URL(`${base}/calendars`).pathname],
    ["GET", new URL(`${base}/calendar`).pathname],
    ["GET", new URL(`${base}/calendars/c%2F%2B`).pathname],
    ["POST", new URL(`${base}/calendars`).pathname],
    ["PATCH", new URL(`${base}/calendars/c%2F%2B`).pathname],
    ["DELETE", new URL(`${base}/calendars/c%2F%2B`).pathname],
  ])
  expect(new URL(requests[3].url).searchParams.get("$select")).toBe("id,name")
  expect(JSON.parse(String(requests[5].init.body))).toEqual({
    name: "New name",
    color: "lightBlue",
  })
})

// Countercheck: remove headers from allPages' http.json call; page two loses both preferences.
test("view pagination preserves timezone and immutable IDs across empty pages and DST offsets", async () => {
  const next = `${base}/calendars/c/calendarView?$skiptoken=opaque%2Btoken`
  const requests = mockFetch((r) =>
    r.url === next
      ? json({
          value: [
            { id: "occurrence", type: "occurrence" },
            { id: "exception", type: "exception" },
          ],
        })
      : json({ value: [], "@odata.nextLink": next })
  )
  const { view } = (await connect()).calendar
  const options = { ...range, calendarId: "c", timeZone: "Eastern Standard Time", top: 1000 }
  expect((await collect(view.listAll(mailbox, options))).map((e) => e.id)).toEqual([
    "occurrence",
    "exception",
  ])
  expect(new URL(requests[0].url).searchParams.get("startDateTime")).toBe(range.startDateTime)
  expect(new URL(requests[0].url).searchParams.get("endDateTime")).toBe(range.endDateTime)
  expect(requests[1].url).toBe(next)
  for (const r of requests)
    expect(r.headers.get("prefer")).toBe(
      'IdType="ImmutableId", outlook.timezone="Eastern Standard Time"'
    )
  await view.list(mailbox, range)
  expect(new URL(requests[2].url).pathname).toBe(new URL(`${base}/calendar/calendarView`).pathname)
})

test("events retain recurrence, Teams, attendees and caller transaction ID without extra requests", async () => {
  const requests = mockFetch((r) =>
    r.method === "DELETE"
      ? new Response(null, { status: 204 })
      : json({ id: "event/1", type: "seriesMaster" })
  )
  const { events } = (await connect()).calendar
  const input: CalendarEventInput = {
    ...event,
    body: { contentType: "html", content: "<p>Review</p>" },
    attendees: [{ emailAddress: { address: "invitee@example.com" }, type: "required" }],
    recurrence: {
      pattern: { type: "weekly", interval: 1, daysOfWeek: ["sunday"], firstDayOfWeek: "monday" },
      range: {
        type: "numbered",
        startDate: "2026-11-01",
        numberOfOccurrences: 3,
        recurrenceTimeZone: "Eastern Standard Time",
      },
    },
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
  }
  await events.create(mailbox, input, {
    calendarId: "secondary",
    timeZone: "Eastern Standard Time",
  })
  expect(requests).toHaveLength(1)
  expect(requests[0].url).toBe(`${base}/calendars/secondary/events`)
  expect(JSON.parse(String(requests[0].init.body))).toEqual(input)
  const body = {
    contentType: "html" as const,
    content: "<p>Updated</p><div>Existing Teams meeting HTML</div>",
  }
  await events.update(mailbox, "event/1", { body })
  expect(JSON.parse(String(requests[1].init.body))).toEqual({ body })
  await events.get(mailbox, "event/1", { select: ["subject"] })
  expect(requests[2].url).toContain("events/event%2F1?")
  await events.delete(mailbox, "event/1")
  expect(requests[3].method).toBe("DELETE")
  expect(requests.every((r) => r.headers.get("prefer")?.includes('IdType="ImmutableId"'))).toBe(
    true
  )
})

test("event listing and instances expose masters separately from occurrences", async () => {
  const requests = mockFetch((r) =>
    json({
      value: [{ id: "id", type: r.url.includes("/instances?") ? "occurrence" : "seriesMaster" }],
    })
  )
  const { events } = (await connect()).calendar
  expect(
    (
      await events.list(mailbox, {
        calendarId: "c",
        filter: "isCancelled eq false",
        orderBy: "start/dateTime",
        top: 10,
      })
    ).value[0].type
  ).toBe("seriesMaster")
  expect((await collect(events.listAll(mailbox)))[0].type).toBe("seriesMaster")
  expect((await events.instances(mailbox, "master/1", range)).value[0].type).toBe("occurrence")
  expect((await collect(events.allInstances(mailbox, "master/1", range)))[0].type).toBe(
    "occurrence"
  )
  expect(new URL(requests[0].url).searchParams.get("$filter")).toBe("isCancelled eq false")
  expect(requests[2].url).toContain("/events/master%2F1/instances?")
})

test("all-day dates stay at local midnight across DST and recurrence can be cleared", async () => {
  const requests = mockFetch(() => json({ id: "event" }))
  const { events } = (await connect()).calendar
  const input = {
    ...event,
    isAllDay: true,
    start: { ...event.start, dateTime: "2026-11-01T00:00:00" },
    end: { ...event.end, dateTime: "2026-11-02T00:00:00" },
  }
  await events.create(mailbox, input)
  expect(JSON.parse(String(requests[0].init.body))).toEqual(input)
  await events.update(mailbox, "id", { recurrence: null })
  expect(JSON.parse(String(requests[1].init.body))).toEqual({ recurrence: null })
})

test("invalid ranges, all-day writes, recurrence and header injection fail before HTTP", async () => {
  const requests = mockFetch(() => json({ id: "event" }))
  const { events, view } = (await connect()).calendar
  for (const input of [
    { ...event, isAllDay: true },
    { ...event, end: event.start },
    { ...event, start: { ...event.start, dateTime: "not a date" } },
    { ...event, reminderMinutesBeforeStart: -1 },
    { ...event, start: { ...event.start, dateTime: "2026-02-30T09:00:00" } },
    {
      ...event,
      recurrence: {
        pattern: { type: "daily" as const, interval: 0 },
        range: { type: "noEnd" as const, startDate: "2026-11-01" },
      },
    },
    {
      ...event,
      recurrence: {
        pattern: { type: "absoluteYearly" as const, interval: 1, month: 13, dayOfMonth: 1 },
        range: { type: "numbered" as const, startDate: "2026-11-01", numberOfOccurrences: 2 },
      },
    },
  ])
    await expect(events.create(mailbox, input)).rejects.toBeInstanceOf(MicrosoftConfigurationError)
  for (const options of [
    { ...range, startDateTime: "2026-11-01T00:00:00" },
    { ...range, endDateTime: range.startDateTime },
    { ...range, top: 1001 },
    { ...range, startDateTime: "2026-02-30T00:00:00Z" },
    { ...range, timeZone: 'UTC", odata.maxpagesize=999' },
  ])
    await expect(view.list(mailbox, options)).rejects.toBeInstanceOf(MicrosoftConfigurationError)
  expect(requests).toHaveLength(0)
})

test("RSVP, proposed time, forwarding and organizer cancellation use explicit Graph actions", async () => {
  const requests = mockFetch(
    () => new Response(null, { status: 202, headers: { "request-id": "r1" } })
  )
  const { events } = (await connect()).calendar
  const proposedNewTime = { start: event.start, end: event.end }
  expect(await events.accept(mailbox, "id", { sendResponse: false })).toEqual({
    status: "accepted",
    requestId: "r1",
  })
  await events.tentativelyAccept(mailbox, "id", { proposedNewTime, sendResponse: true })
  await events.decline(mailbox, "id", { comment: "Unavailable", sendResponse: true })
  await events.forward(mailbox, "id", {
    toRecipients: [{ emailAddress: { address: "other@example.com" } }],
  })
  await events.cancel(mailbox, "id", { comment: "Rescheduled" })
  expect(requests.map((r) => new URL(r.url).pathname.split("/").pop())).toEqual([
    "accept",
    "tentativelyAccept",
    "decline",
    "forward",
    "cancel",
  ])
  expect(JSON.parse(String(requests[0].init.body))).toEqual({ sendResponse: false })
  expect(JSON.parse(String(requests[1].init.body))).toEqual({ proposedNewTime, sendResponse: true })
  expect(requests.every((r) => r.method === "POST")).toBe(true)
  expect(() => events.decline(mailbox, "id", { proposedNewTime, sendResponse: false })).toThrow(
    MicrosoftConfigurationError
  )
  expect(() => events.forward(mailbox, "id", { toRecipients: [] })).toThrow(
    MicrosoftConfigurationError
  )
})

// Countercheck: change the accepted status check to response.ok; a 200 is falsely reported accepted.
test("unexpected action status is not accepted and Graph errors retain their status/code", async () => {
  const { events } = (await connect()).calendar
  mockFetch(() => json({}))
  await expect(events.accept(mailbox, "id")).rejects.toBeInstanceOf(MicrosoftProtocolError)
  mockFetch(() => apiError(400, "ErrorOccurrenceCrossingBoundary"))
  await expect(events.update(mailbox, "id", { start: event.start })).rejects.toMatchObject({
    status: 400,
    code: "ErrorOccurrenceCrossingBoundary",
  })
  await expect(events.cancel(mailbox, "id")).rejects.toMatchObject({ status: 400 })
})

// Countercheck: remove http.ts's GET-only retryable gate; the custom retry policy replays the mutation.
test("calendar mutations never replay, and transport interruptions expose uncertainty", async () => {
  const { calendar } = await connect({
    retry: { maxRetries: 2, delayMs: () => 0, shouldRetry: () => true },
  })
  const requests = mockFetch(() => apiError(503, "ServiceUnavailable"))
  await expect(calendar.events.create(mailbox, event)).rejects.toMatchObject({ status: 503 })
  expect(requests).toHaveLength(1)
  const lost = mockFetch(() => {
    throw new TypeError("connection lost")
  })
  for (const call of [
    () => calendar.events.create(mailbox, event),
    () => calendar.events.update(mailbox, "id", { subject: "x" }),
    () => calendar.events.accept(mailbox, "id"),
    () => calendar.events.delete(mailbox, "id"),
    () => calendar.calendars.create(mailbox, "x"),
  ]) {
    await expect(call()).rejects.toBeInstanceOf(MicrosoftCalendarMutationError)
  }
  expect(lost).toHaveLength(5)
})

// Countercheck: return when result.value is empty in delta.pages; the checkpoint/removal page is lost.
test("primary-calendar delta follows opaque cursors through empty pages and preserves removals", async () => {
  const next = `${base}/calendarView/delta?$skiptoken=opaque%2B%2F%3D`
  const delta = `${base}/calendarView/delta?$deltatoken=checkpoint%2B%2F%3D`
  const requests = mockFetch((r) =>
    r.url === next || r.url === delta
      ? json({
          value: [{ id: "removed", "@removed": { reason: "deleted" } }],
          "@odata.deltaLink": delta,
        })
      : json({ value: [], "@odata.nextLink": next })
  )
  const { view } = (await connect()).calendar
  const pages = await collect(
    view.delta.pages(mailbox, { ...range, timeZone: "Eastern Standard Time", pageSize: 2 })
  )
  expect(pages).toHaveLength(2)
  expect(pages[1].value).toEqual([{ id: "removed", "@removed": { reason: "deleted" } }])
  expect(pages[1]["@odata.deltaLink"]).toBe(delta)
  expect(requests[1].url).toBe(next)
  expect(
    requests.every(
      (r) =>
        r.headers.get("prefer") ===
        'IdType="ImmutableId", outlook.timezone="Eastern Standard Time", odata.maxpagesize=2'
    )
  ).toBe(true)
  await view.delta.list(mailbox, { cursor: delta })
  expect(requests[2].url).toBe(delta)
})

test("delta rejects unsupported query options, hostile cursors, invalid pages and cycles", async () => {
  const requests = mockFetch(() => json({ value: [] }))
  const { view } = (await connect()).calendar
  for (const extra of [
    { calendarId: "secondary" },
    { select: ["subject"] },
    { filter: "x" },
    { cursor: `${base}/calendarView/delta?$deltatoken=x` },
  ]) {
    await expect(
      view.delta.list(mailbox, { ...range, ...extra } as CalendarDeltaOptions)
    ).rejects.toBeInstanceOf(MicrosoftConfigurationError)
  }
  await expect(
    view.delta.list(mailbox, { cursor: "https://evil.example/steal" })
  ).rejects.toBeInstanceOf(MicrosoftProtocolError)
  expect(requests).toHaveLength(0)
  await expect(view.delta.list(mailbox, range)).rejects.toBeInstanceOf(MicrosoftProtocolError)
  const cursor = `${base}/calendarView/delta?$skiptoken=loop`
  mockFetch(() => json({ value: [], "@odata.nextLink": cursor, "@odata.deltaLink": cursor }))
  await expect(view.delta.list(mailbox, range)).rejects.toBeInstanceOf(MicrosoftProtocolError)
  mockFetch(() => json({ value: [], "@odata.nextLink": cursor }))
  await expect(collect(view.delta.pages(mailbox, { cursor }))).rejects.toBeInstanceOf(
    MicrosoftProtocolError
  )
  mockFetch(() => apiError(410, "SyncStateNotFound"))
  await expect(view.delta.list(mailbox, { cursor })).rejects.toMatchObject({
    status: 410,
    code: "SyncStateNotFound",
  })
})

test("getSchedule preserves per-mailbox failures and does not require entity IDs", async () => {
  const result = {
    value: [
      { scheduleId: "one@example.com", availabilityView: "0022" },
      {
        scheduleId: "missing@example.com",
        error: { responseCode: "ErrorMailRecipientNotFound", message: "not found" },
      },
    ],
  }
  const requests = mockFetch(() => json(result))
  const { calendar } = await connect()
  const input = {
    schedules: ["one@example.com", "missing@example.com"],
    startTime: event.start,
    endTime: event.end,
    availabilityViewInterval: 15,
  }
  expect(await calendar.getSchedule(mailbox, input, { timeZone: "Eastern Standard Time" })).toEqual(
    result
  )
  expect(requests[0].method).toBe("POST")
  expect(requests[0].url).toBe(`${base}/calendar/getSchedule`)
  expect(JSON.parse(String(requests[0].init.body))).toEqual(input)
  await expect(
    calendar.getSchedule(mailbox, { ...input, schedules: Array(21).fill("one@example.com") })
  ).rejects.toBeInstanceOf(MicrosoftConfigurationError)
  await expect(
    calendar.getSchedule(mailbox, { ...input, availabilityViewInterval: 4 })
  ).rejects.toBeInstanceOf(MicrosoftConfigurationError)
  expect(requests).toHaveLength(1)
  mockFetch(() => json({ value: [{ id: "wrong key" }] }))
  await expect(calendar.getSchedule(mailbox, input)).rejects.toBeInstanceOf(MicrosoftProtocolError)
})

test("connection cancellation prevents further calendar pages", async () => {
  const controller = new AbortController()
  const requests = mockFetch(() => {
    controller.abort()
    return json({
      value: [{ id: "first" }],
      "@odata.nextLink": `${base}/calendar/events?$skiptoken=next`,
    })
  })
  const { calendar } = await connect({}, { ...CONTEXT, signal: controller.signal })
  await expect(collect(calendar.events.listAll(mailbox))).rejects.toBeInstanceOf(Error)
  expect(requests).toHaveLength(1)
})
