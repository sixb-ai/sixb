import { afterEach, describe, expect, test } from "bun:test"
import { CtmApiError } from "../src"
import {
  ACCOUNT_ID,
  callPage,
  callRecord,
  collect,
  createTestClient,
  empty,
  json,
  recorder,
  route,
} from "./helpers"

const originalFetch = globalThis.fetch
const CALLS = `/api/v1/accounts/${ACCOUNT_ID}/calls`

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("calls.list", () => {
  test("sends CTM's parameter names, with array filters written direction[]", async () => {
    const calls = recorder([callPage([callRecord(1)], "next")])
    const client = await createTestClient()

    const result = await client.calls.list({
      startDate: "2026-11-01",
      endDate: "2026-11-12",
      directions: ["inbound", "form"],
      fields: ["id", "audio"],
      filter: 'source:"Google Ads"',
      pageSize: 100,
      order: "metrics",
      stats: true,
      withTime: true,
      agencyWide: true,
      contactNumber: "+1251",
    })

    expect(route(calls[0]!)).toBe(
      `GET ${CALLS}?per_page=100&start_date=2026-11-01&end_date=2026-11-12&with_time=1` +
        "&direction[]=inbound&direction[]=form" +
        '&filter=source:"Google+Ads"&contact_number=+1251' +
        "&limit_fields[]=id&limit_fields[]=audio&order=metrics&stats=on&all=1"
    )
    expect(result).toMatchObject({ after: "next", totalEntries: 1, perPage: 10, stats: {} })
    expect(result.records.map((call) => call.id)).toEqual([1])
  })

  test("listAll follows after until a page has none", async () => {
    const calls = recorder([
      callPage([callRecord(1), callRecord(2)], "c2"),
      callPage([callRecord(3)], "c3"),
      callPage([], "c3-again"),
    ])
    const client = await createTestClient()

    const all = await collect(client.calls.listAll({ timeDuration: "last7days" }))

    expect(all.map((call) => call.id)).toEqual([1, 2, 3])
    expect(calls.map(route)).toEqual([
      `GET ${CALLS}?per_page=100&time_duration=last7days`,
      `GET ${CALLS}?after=c2&per_page=100&time_duration=last7days`,
      `GET ${CALLS}?after=c3&per_page=100&time_duration=last7days`,
    ])
  })

  test("listAll stops on a page without a cursor", async () => {
    recorder([callPage([callRecord(1)], null)])
    const client = await createTestClient()

    expect(await collect(client.calls.listAll())).toHaveLength(1)
  })

  test("listAll refuses a cursor that repeats instead of looping", async () => {
    recorder([callPage([callRecord(1)], "same"), callPage([callRecord(2)], "same")])
    const client = await createTestClient()

    const error = await collect(client.calls.listAll()).catch((caught: unknown) => caught)

    expect(String(error)).toContain("repeated after cursor")
  })
})

describe("calls.search", () => {
  test("posts the options and the query object as JSON", async () => {
    const calls = recorder([callPage([callRecord(1)])])
    const client = await createTestClient()

    await client.calls.search({
      startDate: "2026-11-01",
      directions: ["inbound"],
      fields: ["id"],
      query: { tracking_number: "14105555555" },
    })

    expect(route(calls[0]!)).toBe(`POST ${CALLS}/search.json`)
    expect(calls[0]?.body).toEqual({
      start_date: "2026-11-01",
      direction: ["inbound"],
      limit_fields: ["id"],
      query: { tracking_number: "14105555555" },
    })
  })

  test("searchAll sends both the page number and the cursor, since search reads page", async () => {
    const calls = recorder([callPage([callRecord(1)], "c2"), callPage([])])
    const client = await createTestClient()

    await collect(client.calls.searchAll({ filter: "x" }))

    expect(calls[0]?.body).toEqual({ page: 1, per_page: 100, filter: "x" })
    expect(calls[1]?.body).toEqual({ after: "c2", page: 2, per_page: 100, filter: "x" })
  })
})

describe("one call", () => {
  test("reads the detail, the transcript, the mapping and the recording", async () => {
    const calls = recorder([
      json(callRecord(7, { caller: { id: "12345.12512862740", name: "Ada" } })),
      json({ callid: 7, text: "Hello", sentiment: 2, outline: [], versions: [1] }),
      json({ call: { fields: [] } }),
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }),
    ])
    const client = await createTestClient()

    const call = await client.calls.get(7)
    const transcript = await client.calls.transcript(7)
    const mapping = await client.calls.mapping()
    const recording = await client.calls.recording("CA7")

    expect(call.caller?.name).toBe("Ada")
    expect(transcript.text).toBe("Hello")
    expect(mapping).toEqual({ call: { fields: [] } })
    expect(recording.headers.get("content-type")).toBe("audio/mpeg")
    expect(new Uint8Array(await recording.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(calls[3]?.headers.get("accept")).toBe("*/*")
    expect(calls.map(route)).toEqual([
      `GET ${CALLS}/7`,
      `GET ${CALLS}/7/transcription.json`,
      `GET ${CALLS}/mapping`,
      `GET ${CALLS}/CA7/recording`,
    ])
  })

  test("a missing recording is an API error, not an empty file", async () => {
    recorder([json({ error: "No recording" }, { status: 404 })])
    const client = await createTestClient()

    const error = await client.calls.recording("CA7").catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CtmApiError)
    expect(error).toMatchObject({ status: 404 })
  })

  test("update returns the call from CTM's envelope", async () => {
    const calls = recorder([
      json({ status: true, call: callRecord(7, { custom_fields: { plan: "pro" } }) }),
    ])
    const client = await createTestClient()

    const call = await client.calls.update(7, { custom_fields: { plan: "pro" }, triggers: 0 })

    expect(route(calls[0]!)).toBe(`POST ${CALLS}/7/modify`)
    expect(calls[0]?.body).toEqual({ custom_fields: { plan: "pro" }, triggers: 0 })
    expect(call.custom_fields).toEqual({ plan: "pro" })
  })

  test("update fails loudly when CTM leaves the call out", async () => {
    recorder([json({ status: false })])
    const client = await createTestClient()

    const error = await client.calls.update(7, { name: "Ada" }).catch((caught: unknown) => caught)

    expect(String(error)).toContain("without the call")
  })

  test("sale records send conversion as 1 or 0", async () => {
    const calls = recorder([
      json({ name: "Pro", conversion: 1, value: 120 }),
      json({ status: "success" }),
      json({ status: "success" }),
      json({ status: "success" }),
    ])
    const client = await createTestClient()

    const sale = await client.calls.getSale(7)
    await client.calls.saveSale(7, { conversion: true, value: 120, score: 5 })
    await client.calls.saveSale(7, { conversion: false })
    await client.calls.deleteSale(7)

    expect(sale.value).toBe(120)
    expect(calls[1]?.body).toEqual({ conversion: 1, value: 120, score: 5 })
    expect(calls[2]?.body).toEqual({ conversion: 0 })
    expect(calls.map(route)).toEqual([
      `GET ${CALLS}/7/sale`,
      `POST ${CALLS}/7/sale`,
      `POST ${CALLS}/7/sale`,
      `DELETE ${CALLS}/7/sale`,
    ])
  })

  test("comments carry the note ID in the body", async () => {
    const comment = { id: 9, call_id: 7, note: "hi", owner: true, this_call: true, agent: null }
    const calls = recorder([json(comment), json(comment), json({ status: "success", id: 9 })])
    const client = await createTestClient()

    await client.calls.addComment(7, { note: "hi", user: "agent@example.com" })
    await client.calls.updateComment(7, 9, { note: "hello" })
    await client.calls.deleteComment(7, 9)

    expect(calls.map((call) => [route(call), call.body])).toEqual([
      [`POST ${CALLS}/7/add_comment`, { note: "hi", user: "agent@example.com" }],
      [`POST ${CALLS}/7/update_comment`, { note: "hello", note_id: 9 }],
      [`DELETE ${CALLS}/7/delete_comment`, { note_id: 9 }],
    ])

    const blank = await client.calls.addComment(7, { note: " " }).catch((caught) => caught)
    expect(String(blank)).toContain("note must not be empty")
  })

  test("tags go in the query string, encoded, and spam has its own routes", async () => {
    const calls = recorder([
      json({ status: "success" }),
      json({ status: "success" }),
      json({ status: "success" }),
      empty(204),
    ])
    const client = await createTestClient()

    await client.calls.addTag(7, "hot lead & co")
    await client.calls.removeTag(7, "hot lead & co")
    await client.calls.markSpam(7)
    await client.calls.unmarkSpam(7)

    expect(calls[0]?.url.searchParams.get("tag")).toBe("hot lead & co")
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      `PATCH ${CALLS}/7/tag`,
      `DELETE ${CALLS}/7/tag`,
      `POST ${CALLS}/7/spam`,
      `POST ${CALLS}/7/unspam`,
    ])
  })
})
