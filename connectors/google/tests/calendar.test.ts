import { afterEach, beforeEach, expect, test } from "bun:test"
import { GoogleApiError } from "../src/errors"
import { google } from "../src/google"
import type { GoogleClient } from "../src/index"
import { CONTEXT, collect, json, mockFetch, restoreFetch } from "./helpers"

const BASE = "https://www.googleapis.com/calendar/v3/"

interface Recorded {
  url: string
  method: string
  auth: string | null
  body: unknown
}

let requests: Recorded[]

async function connect(): Promise<GoogleClient> {
  return google({ auth: { token: () => "test-token" } }).connect(CONTEXT)
}

function record(input: RequestInfo | URL, init?: RequestInit): void {
  requests.push({
    url: input.toString(),
    method: (init?.method ?? "GET").toString(),
    auth: new Headers(init?.headers).get("authorization"),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
  })
}

beforeEach(() => {
  requests = []
})

afterEach(restoreFetch)

const insertedEvent = {
  summary: "Kickoff",
  start: { dateTime: "2026-02-01T10:00:00Z" },
  end: { dateTime: "2026-02-01T11:00:00Z" },
  conferenceData: {
    createRequest: {
      requestId: "meet-request-1",
      conferenceSolutionKey: { type: "hangoutsMeet" as const },
    },
  },
}

const freeBusyQuery = {
  timeMin: "2026-01-01T00:00:00Z",
  timeMax: "2026-01-02T00:00:00Z",
  items: [{ id: "primary" }],
}

// Every single-request method: verb, path (encoded IDs included), query and JSON body (null: none).
test.each<[string, (client: GoogleClient) => Promise<unknown>, string, string, unknown]>([
  [
    "events.list",
    (client) =>
      client.calendar.events.list("primary", {
        timeMin: "2026-01-01T00:00:00Z",
        singleEvents: true,
        orderBy: "startTime",
      }),
    "GET",
    "calendars/primary/events?timeMin=2026-01-01T00%3A00%3A00Z&singleEvents=true&orderBy=startTime",
    null,
  ],
  [
    "events.list on an email calendar id",
    (client) => client.calendar.events.list("me@corp.com"),
    "GET",
    "calendars/me%40corp.com/events",
    null,
  ],
  [
    "events.get",
    (client) => client.calendar.events.get("primary", "abc"),
    "GET",
    "calendars/primary/events/abc",
    null,
  ],
  [
    "events.insert",
    (client) =>
      client.calendar.events.insert("primary", insertedEvent, {
        sendUpdates: "all",
        conferenceDataVersion: 1,
      }),
    "POST",
    "calendars/primary/events?sendUpdates=all&conferenceDataVersion=1",
    insertedEvent,
  ],
  [
    "events.update",
    (client) => client.calendar.events.update("primary", "abc", { summary: "Renamed" }),
    "PUT",
    "calendars/primary/events/abc",
    { summary: "Renamed" },
  ],
  [
    "events.patch",
    (client) => client.calendar.events.patch("primary", "abc", { location: "Room 4" }),
    "PATCH",
    "calendars/primary/events/abc",
    { location: "Room 4" },
  ],
  [
    "events.delete",
    (client) => client.calendar.events.delete("primary", "abc", { sendUpdates: "none" }),
    "DELETE",
    "calendars/primary/events/abc?sendUpdates=none",
    null,
  ],
  [
    "events.import",
    (client) => client.calendar.events.import("primary", { iCalUID: "uid@x", summary: "Imported" }),
    "POST",
    "calendars/primary/events/import",
    { iCalUID: "uid@x", summary: "Imported" },
  ],
  [
    "events.move",
    (client) => client.calendar.events.move("primary", "abc", { destination: "other@group" }),
    "POST",
    "calendars/primary/events/abc/move?destination=other%40group",
    null,
  ],
  [
    "events.quickAdd",
    (client) => client.calendar.events.quickAdd("primary", { text: "Lunch tomorrow 12pm" }),
    "POST",
    "calendars/primary/events/quickAdd?text=Lunch+tomorrow+12pm",
    null,
  ],
  [
    "events.watch",
    (client) =>
      client.calendar.events.watch("primary", {
        id: "chan",
        type: "web_hook",
        address: "https://example.com/hook",
      }),
    "POST",
    "calendars/primary/events/watch",
    { id: "chan", type: "web_hook", address: "https://example.com/hook" },
  ],
  [
    "calendars.get",
    (client) => client.calendar.calendars.get("cal-1"),
    "GET",
    "calendars/cal-1",
    null,
  ],
  [
    "calendars.insert",
    (client) => client.calendar.calendars.insert({ summary: "Team" }),
    "POST",
    "calendars",
    { summary: "Team" },
  ],
  [
    "calendars.update",
    (client) => client.calendar.calendars.update("cal-1", { summary: "Team 2" }),
    "PUT",
    "calendars/cal-1",
    { summary: "Team 2" },
  ],
  [
    "calendars.patch",
    (client) => client.calendar.calendars.patch("cal-1", { location: "HQ" }),
    "PATCH",
    "calendars/cal-1",
    { location: "HQ" },
  ],
  [
    "calendars.delete",
    (client) => client.calendar.calendars.delete("cal-1"),
    "DELETE",
    "calendars/cal-1",
    null,
  ],
  [
    "calendars.clear",
    (client) => client.calendar.calendars.clear("primary"),
    "POST",
    "calendars/primary/clear",
    null,
  ],
  [
    "calendarList.get",
    (client) => client.calendar.calendarList.get("cal-1"),
    "GET",
    "users/me/calendarList/cal-1",
    null,
  ],
  [
    "calendarList.insert",
    (client) => client.calendar.calendarList.insert({ id: "cal-2" }),
    "POST",
    "users/me/calendarList",
    { id: "cal-2" },
  ],
  [
    "calendarList.update",
    (client) => client.calendar.calendarList.update("cal-1", { id: "cal-1" }),
    "PUT",
    "users/me/calendarList/cal-1",
    { id: "cal-1" },
  ],
  [
    "calendarList.patch",
    (client) => client.calendar.calendarList.patch("cal-1", { hidden: true }),
    "PATCH",
    "users/me/calendarList/cal-1",
    { hidden: true },
  ],
  [
    "calendarList.delete",
    (client) => client.calendar.calendarList.delete("cal-1"),
    "DELETE",
    "users/me/calendarList/cal-1",
    null,
  ],
  [
    "calendarList.watch",
    (client) => client.calendar.calendarList.watch({ id: "chan" }),
    "POST",
    "users/me/calendarList/watch",
    { id: "chan" },
  ],
  [
    "acl.list",
    (client) => client.calendar.acl.list("primary"),
    "GET",
    "calendars/primary/acl",
    null,
  ],
  [
    "acl.get",
    (client) => client.calendar.acl.get("primary", "user:me@x"),
    "GET",
    "calendars/primary/acl/user%3Ame%40x",
    null,
  ],
  [
    "acl.insert",
    (client) =>
      client.calendar.acl.insert("primary", {
        role: "reader",
        scope: { type: "user", value: "me@x" },
      }),
    "POST",
    "calendars/primary/acl",
    { role: "reader", scope: { type: "user", value: "me@x" } },
  ],
  [
    "acl.update",
    (client) => client.calendar.acl.update("primary", "user:me@x", { role: "writer" }),
    "PUT",
    "calendars/primary/acl/user%3Ame%40x",
    { role: "writer" },
  ],
  [
    "acl.patch",
    (client) => client.calendar.acl.patch("primary", "user:me@x", { role: "owner" }),
    "PATCH",
    "calendars/primary/acl/user%3Ame%40x",
    { role: "owner" },
  ],
  [
    "acl.delete",
    (client) => client.calendar.acl.delete("primary", "user:me@x"),
    "DELETE",
    "calendars/primary/acl/user%3Ame%40x",
    null,
  ],
  [
    "acl.watch",
    (client) => client.calendar.acl.watch("primary", { id: "chan" }),
    "POST",
    "calendars/primary/acl/watch",
    { id: "chan" },
  ],
  [
    "settings.get",
    (client) => client.calendar.settings.get("timezone"),
    "GET",
    "users/me/settings/timezone",
    null,
  ],
  ["settings.list", (client) => client.calendar.settings.list(), "GET", "users/me/settings", null],
  ["colors.get", (client) => client.calendar.colors.get(), "GET", "colors", null],
  [
    "freebusy.query",
    (client) => client.calendar.freebusy.query(freeBusyQuery),
    "POST",
    "freeBusy",
    freeBusyQuery,
  ],
  [
    "channels.stop",
    (client) => client.calendar.channels.stop({ id: "chan", resourceId: "res" }),
    "POST",
    "channels/stop",
    { id: "chan", resourceId: "res" },
  ],
])("%s sends its verb, path, query and body", async (_name, call, method, path, body) => {
  mockFetch(async (input, init) => {
    record(input, init)
    // Deletes and channel stops answer 204 with no body; the call must still resolve.
    return init?.method === "DELETE" || path === "channels/stop"
      ? new Response(null, { status: 204 })
      : json({ id: "x" })
  })

  await call(await connect())

  expect(requests).toEqual([{ url: `${BASE}${path}`, method, auth: "Bearer test-token", body }])
})

test.each<[string, (client: GoogleClient) => AsyncIterable<{ id?: string }>, string]>([
  [
    "events.listAll",
    (client) => client.calendar.events.listAll("primary", { maxResults: 2 }),
    "calendars/primary/events?maxResults=2",
  ],
  [
    "events.instancesAll",
    (client) => client.calendar.events.instancesAll("primary", "recurring"),
    "calendars/primary/events/recurring/instances",
  ],
  [
    "calendarList.listAll",
    (client) => client.calendar.calendarList.listAll({ minAccessRole: "reader" }),
    "users/me/calendarList?minAccessRole=reader",
  ],
])("%s follows nextPageToken through every page", async (_name, call, path) => {
  const pages = [
    { items: [{ id: "1" }, { id: "2" }], nextPageToken: "p2" },
    { items: [{ id: "3" }], nextSyncToken: "sync-1" },
  ]
  mockFetch(async (input, init) => {
    record(input, init)
    return json(pages[requests.length - 1])
  })

  const items = await collect(call(await connect()))

  expect(items.map((item) => item.id)).toEqual(["1", "2", "3"])
  expect(requests.map((request) => request.url)).toEqual([
    `${BASE}${path}`,
    `${BASE}${path}${path.includes("?") ? "&" : "?"}pageToken=p2`,
  ])
})

test("listAll refuses a page token it already followed instead of looping forever", async () => {
  // Regression check: drop the seen-token check in pagination.ts; the third page then ends the
  // listing normally and nothing rejects.
  const pages = [
    { items: [{ id: "1" }], nextPageToken: "p2" },
    { items: [{ id: "2" }], nextPageToken: "p2" },
    { items: [{ id: "3" }] },
  ]
  mockFetch(async (input, init) => {
    record(input, init)
    return json(pages[requests.length - 1])
  })

  const client = await connect()
  const error = await collect(client.calendar.events.listAll("primary")).catch((e: unknown) => e)

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(
    '[SixbGoogle] Pagination repeated page token "p2"; refusing to loop forever.'
  )
  expect(requests).toHaveLength(2)
})

test("maps a Google error envelope to GoogleApiError", async () => {
  mockFetch(async () =>
    json({ error: { code: 404, message: "Not Found", status: "NOT_FOUND" } }, { status: 404 })
  )

  const client = await connect()
  const error = (await client.calendar.events
    .get("primary", "missing")
    .catch((e) => e)) as GoogleApiError
  expect(error).toBeInstanceOf(GoogleApiError)
  expect(error.status).toBe(404)
  expect(error.message).toContain("Not Found")
})
