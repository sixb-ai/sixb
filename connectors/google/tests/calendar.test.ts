import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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

async function connect(): Promise<GoogleClient> {
  return google({ auth: { token: () => "test-token" } }).connect(CONTEXT)
}

afterEach(restoreFetch)

describe("calendar.events", () => {
  let requests: Recorded[]

  beforeEach(() => {
    requests = []
  })

  function record(input: RequestInfo | URL, init?: RequestInit): void {
    let body: unknown
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    requests.push({
      url: input.toString(),
      method: (init?.method ?? "GET").toString(),
      auth: new Headers(init?.headers).get("authorization"),
      body,
    })
  }

  test("list issues GET with query, path, and bearer auth", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({ items: [{ id: "e1", summary: "Standup" }] })
    })

    const client = await connect()
    const result = await client.calendar.events.list("primary", {
      timeMin: "2026-01-01T00:00:00Z",
      singleEvents: true,
      orderBy: "startTime",
    })

    expect(result.items?.[0]?.id).toBe("e1")
    expect(requests[0]?.method).toBe("GET")
    expect(requests[0]?.auth).toBe("Bearer test-token")
    expect(requests[0]?.url).toBe(
      `${BASE}calendars/primary/events?timeMin=2026-01-01T00%3A00%3A00Z&singleEvents=true&orderBy=startTime`
    )
  })

  test("list encodes an email calendar id in the path", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({ items: [] })
    })

    const client = await connect()
    await client.calendar.events.list("me@corp.com")

    expect(requests[0]?.url).toBe(`${BASE}calendars/me%40corp.com/events`)
  })

  test("listAll walks every page via nextPageToken", async () => {
    const pages = [
      { items: [{ id: "1" }, { id: "2" }], nextPageToken: "p2" },
      { items: [{ id: "3" }], nextSyncToken: "sync-1" },
    ]
    let call = 0
    mockFetch(async (input, init) => {
      record(input, init)
      return json(pages[call++])
    })

    const client = await connect()
    const events = await collect(client.calendar.events.listAll("primary", { maxResults: 2 }))

    expect(events.map((e) => e.id)).toEqual(["1", "2", "3"])
    expect(requests).toHaveLength(2)
    expect(requests[1]?.url).toContain("pageToken=p2")
  })

  test("get fetches a single event by id", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({ id: "abc", summary: "Review" })
    })

    const client = await connect()
    const event = await client.calendar.events.get("primary", "abc")

    expect(event.summary).toBe("Review")
    expect(requests[0]?.method).toBe("GET")
    expect(requests[0]?.url).toBe(`${BASE}calendars/primary/events/abc`)
  })

  test("insert POSTs a JSON body", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({ id: "new", summary: "Kickoff" })
    })

    const client = await connect()
    const created = await client.calendar.events.insert(
      "primary",
      {
        summary: "Kickoff",
        start: { dateTime: "2026-02-01T10:00:00Z" },
        end: { dateTime: "2026-02-01T11:00:00Z" },
        conferenceData: {
          createRequest: {
            requestId: "meet-request-1",
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      },
      { sendUpdates: "all", conferenceDataVersion: 1 }
    )

    expect(created.id).toBe("new")
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toBe(
      `${BASE}calendars/primary/events?sendUpdates=all&conferenceDataVersion=1`
    )
    expect(requests[0]?.body).toMatchObject({
      summary: "Kickoff",
      conferenceData: {
        createRequest: {
          requestId: "meet-request-1",
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    })
  })

  test("update uses PUT with a body", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({ id: "abc", summary: "Renamed" })
    })

    const client = await connect()
    await client.calendar.events.update("primary", "abc", { summary: "Renamed" })

    expect(requests[0]?.method).toBe("PUT")
    expect(requests[0]?.url).toBe(`${BASE}calendars/primary/events/abc`)
    expect(requests[0]?.body).toMatchObject({ summary: "Renamed" })
  })

  test("patch uses PATCH with a partial body", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({ id: "abc", location: "Room 4" })
    })

    const client = await connect()
    await client.calendar.events.patch("primary", "abc", { location: "Room 4" })

    expect(requests[0]?.method).toBe("PATCH")
    expect(requests[0]?.body).toMatchObject({ location: "Room 4" })
  })

  test("delete uses DELETE, sends auth, sends no body, and resolves on 204", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return new Response(null, { status: 204 })
    })

    const client = await connect()
    await expect(
      client.calendar.events.delete("primary", "abc", { sendUpdates: "none" })
    ).resolves.toBeUndefined()

    expect(requests[0]?.method).toBe("DELETE")
    expect(requests[0]?.auth).toBe("Bearer test-token")
    expect(requests[0]?.body).toBeUndefined()
    expect(requests[0]?.url).toBe(`${BASE}calendars/primary/events/abc?sendUpdates=none`)
  })

  test("import POSTs to /events/import", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({ id: "imported" })
    })

    const client = await connect()
    await client.calendar.events.import("primary", { iCalUID: "uid@x", summary: "Imported" })

    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toBe(`${BASE}calendars/primary/events/import`)
    expect(requests[0]?.body).toMatchObject({ iCalUID: "uid@x" })
  })

  test("instances GETs, instancesAll paginates", async () => {
    const pages = [{ items: [{ id: "i1" }], nextPageToken: "n2" }, { items: [{ id: "i2" }] }]
    let call = 0
    mockFetch(async (input, init) => {
      record(input, init)
      return json(pages[call++])
    })

    const client = await connect()
    const all = await collect(client.calendar.events.instancesAll("primary", "recurring"))

    expect(all.map((e) => e.id)).toEqual(["i1", "i2"])
    expect(requests[0]?.url).toBe(`${BASE}calendars/primary/events/recurring/instances`)
    expect(requests[1]?.url).toContain("pageToken=n2")
  })

  test("move POSTs with the destination query and no body", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({ id: "abc" })
    })

    const client = await connect()
    await client.calendar.events.move("primary", "abc", { destination: "other@group" })

    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toBe(
      `${BASE}calendars/primary/events/abc/move?destination=other%40group`
    )
    expect(requests[0]?.body).toBeUndefined()
  })

  test("quickAdd POSTs with the text query", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({ id: "quick" })
    })

    const client = await connect()
    await client.calendar.events.quickAdd("primary", { text: "Lunch tomorrow 12pm" })

    expect(requests[0]?.url).toBe(
      `${BASE}calendars/primary/events/quickAdd?text=Lunch+tomorrow+12pm`
    )
  })

  test("watch POSTs a channel body to /events/watch", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({ id: "chan", resourceId: "res", expiration: "1700000000000" })
    })

    const client = await connect()
    const channel = await client.calendar.events.watch("primary", {
      id: "chan",
      type: "web_hook",
      address: "https://example.com/hook",
    })

    expect(channel.resourceId).toBe("res")
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toBe(`${BASE}calendars/primary/events/watch`)
    expect(requests[0]?.body).toMatchObject({ id: "chan", type: "web_hook" })
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
})

describe("calendar.calendars", () => {
  let requests: Recorded[]

  beforeEach(() => {
    requests = []
  })

  function record(input: RequestInfo | URL, init?: RequestInit): void {
    requests.push({
      url: input.toString(),
      method: (init?.method ?? "GET").toString(),
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
  }

  test("get / insert / update / patch / delete / clear route correctly", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return init?.method === "DELETE" ? new Response(null, { status: 204 }) : json({ id: "cal-1" })
    })

    const client = await connect()
    await client.calendar.calendars.get("cal-1")
    await client.calendar.calendars.insert({ summary: "Team" })
    await client.calendar.calendars.update("cal-1", { summary: "Team 2" })
    await client.calendar.calendars.patch("cal-1", { location: "HQ" })
    await client.calendar.calendars.delete("cal-1")
    await client.calendar.calendars.clear("primary")

    expect(requests.map((r) => `${r.method} ${r.url.replace(BASE, "")}`)).toEqual([
      "GET calendars/cal-1",
      "POST calendars",
      "PUT calendars/cal-1",
      "PATCH calendars/cal-1",
      "DELETE calendars/cal-1",
      "POST calendars/primary/clear",
    ])
    expect(requests[1]?.body).toMatchObject({ summary: "Team" })
  })
})

describe("calendar.calendarList", () => {
  let requests: Recorded[]

  beforeEach(() => {
    requests = []
  })

  function record(input: RequestInfo | URL, init?: RequestInit): void {
    requests.push({
      url: input.toString(),
      method: (init?.method ?? "GET").toString(),
      auth: null,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
  }

  test("routes list/get/insert/update/patch/delete/watch and paginates", async () => {
    const listPages = [
      { items: [{ id: "a" }], nextPageToken: "p2" },
      { items: [{ id: "b" }], nextSyncToken: "s" },
    ]
    let listCall = 0
    mockFetch(async (input, init) => {
      record(input, init)
      const pathname = new URL(input.toString()).pathname
      if (pathname.endsWith("/calendarList") && (init?.method ?? "GET") === "GET") {
        return json(listPages[listCall++])
      }
      return init?.method === "DELETE" ? new Response(null, { status: 204 }) : json({ id: "x" })
    })

    const client = await connect()
    const entries = await collect(client.calendar.calendarList.listAll({ minAccessRole: "reader" }))
    expect(entries.map((e) => e.id)).toEqual(["a", "b"])

    await client.calendar.calendarList.get("cal-1")
    await client.calendar.calendarList.insert({ id: "cal-2" })
    await client.calendar.calendarList.update("cal-1", { id: "cal-1" })
    await client.calendar.calendarList.patch("cal-1", { hidden: true })
    await client.calendar.calendarList.delete("cal-1")
    await client.calendar.calendarList.watch({ id: "chan" })

    const routes = requests.map((r) => `${r.method} ${r.url.replace(BASE, "")}`)
    expect(routes).toContain("GET users/me/calendarList?minAccessRole=reader")
    expect(routes).toContain("GET users/me/calendarList/cal-1")
    expect(routes).toContain("POST users/me/calendarList")
    expect(routes).toContain("PUT users/me/calendarList/cal-1")
    expect(routes).toContain("PATCH users/me/calendarList/cal-1")
    expect(routes).toContain("DELETE users/me/calendarList/cal-1")
    expect(routes).toContain("POST users/me/calendarList/watch")
  })
})

describe("calendar.acl", () => {
  let requests: Recorded[]

  beforeEach(() => {
    requests = []
  })

  function record(input: RequestInfo | URL, init?: RequestInit): void {
    requests.push({
      url: input.toString(),
      method: (init?.method ?? "GET").toString(),
      auth: null,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
  }

  test("routes every ACL method", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : json({ items: [{ id: "user:me@x" }] })
    })

    const client = await connect()
    await client.calendar.acl.list("primary")
    await client.calendar.acl.get("primary", "user:me@x")
    await client.calendar.acl.insert("primary", {
      role: "reader",
      scope: { type: "user", value: "me@x" },
    })
    await client.calendar.acl.update("primary", "user:me@x", { role: "writer" })
    await client.calendar.acl.patch("primary", "user:me@x", { role: "owner" })
    await client.calendar.acl.delete("primary", "user:me@x")
    await client.calendar.acl.watch("primary", { id: "chan" })

    const routes = requests.map((r) => `${r.method} ${r.url.replace(BASE, "")}`)
    expect(routes).toEqual([
      "GET calendars/primary/acl",
      "GET calendars/primary/acl/user%3Ame%40x",
      "POST calendars/primary/acl",
      "PUT calendars/primary/acl/user%3Ame%40x",
      "PATCH calendars/primary/acl/user%3Ame%40x",
      "DELETE calendars/primary/acl/user%3Ame%40x",
      "POST calendars/primary/acl/watch",
    ])
    expect(requests[2]?.body).toMatchObject({ scope: { type: "user" } })
  })
})

describe("calendar.settings / colors / freebusy / channels", () => {
  let requests: Recorded[]

  beforeEach(() => {
    requests = []
  })

  function record(input: RequestInfo | URL, init?: RequestInit): void {
    requests.push({
      url: input.toString(),
      method: (init?.method ?? "GET").toString(),
      auth: null,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
  }

  test("settings.get and settings.list", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return input.toString().endsWith("/timezone")
        ? json({ id: "timezone", value: "Europe/Zurich" })
        : json({ items: [{ id: "locale", value: "en" }] })
    })

    const client = await connect()
    const setting = await client.calendar.settings.get("timezone")
    expect(setting.value).toBe("Europe/Zurich")

    const list = await client.calendar.settings.list()
    expect(list.items?.[0]?.id).toBe("locale")

    expect(requests[0]?.url).toBe(`${BASE}users/me/settings/timezone`)
    expect(requests[1]?.url).toBe(`${BASE}users/me/settings`)
  })

  test("colors.get", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({ kind: "calendar#colors", event: { "1": { background: "#a4bdfc" } } })
    })

    const client = await connect()
    const colors = await client.calendar.colors.get()
    expect(colors.event?.["1"]?.background).toBe("#a4bdfc")
    expect(requests[0]?.url).toBe(`${BASE}colors`)
  })

  test("freebusy.query POSTs the request body", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({
        kind: "calendar#freeBusy",
        calendars: { primary: { busy: [{ start: "s", end: "e" }] } },
      })
    })

    const client = await connect()
    const result = await client.calendar.freebusy.query({
      timeMin: "2026-01-01T00:00:00Z",
      timeMax: "2026-01-02T00:00:00Z",
      items: [{ id: "primary" }],
    })

    expect(result.calendars?.primary?.busy?.[0]?.start).toBe("s")
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toBe(`${BASE}freeBusy`)
    expect(requests[0]?.body).toMatchObject({ items: [{ id: "primary" }] })
  })

  test("channels.stop POSTs the channel body", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return new Response(null, { status: 204 })
    })

    const client = await connect()
    await client.calendar.channels.stop({ id: "chan", resourceId: "res" })

    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toBe(`${BASE}channels/stop`)
    expect(requests[0]?.body).toMatchObject({ id: "chan", resourceId: "res" })
  })
})
