import { afterEach, describe, expect, test } from "bun:test"
import type { AceIotClient, AceIotTimeseriesPage } from "../src"
import { decodeTimeseriesCursor, encodeTimeseriesCursor, repairTimeseriesCursor } from "../src"
import {
  aceTimeseriesServer,
  buildSamples,
  collect,
  createTestClient,
  json,
  mockFetch,
  page,
  sampleKey,
} from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const RANGE = { startTime: "2026-08-07T17:15:00Z", endTime: "2026-08-07T17:30:00Z" }

/**
 * The bucket layout measured on a live site over a 15-minute window: one full 5-minute bucket of
 * 1,464 readings followed by two of 879. It matters that the first bucket is far larger than the
 * page size, because that is the shape that makes ACE's cursor stall.
 */
const BUCKETS = [
  ["2026-08-07T17:15:00", 1464],
  ["2026-08-07T17:20:00", 879],
  ["2026-08-07T17:25:00", 879],
] as const

const sample = (name: string, time: string) => ({ name, value: "1", time })

describe("timeseries cursor repair", () => {
  // Guard proof: make `repairTimeseriesCursor` return `page.next_cursor` and the page-size-50 row
  // fails — walked with ACE's own cursor, the window stalls at 100 of its 3,222 rows, the numbers
  // measured against the live API.
  test.each([
    // Pages that begin and end inside one bucket, the shape that stalls ACE's own cursor.
    50,
    // Pages that cross into later buckets, where ACE's cursor is already right.
    1000,
    // The whole window in one page, with no cursor at all.
    5000,
  ])("page size %i yields every sample exactly once, one request per page", async (pageSize) => {
    const samples = buildSamples(BUCKETS)
    const server = aceTimeseriesServer(samples)
    let requests = 0
    mockFetch((input) => {
      requests += 1
      return Promise.resolve(json(server(new URL(String(input)))))
    })

    const ace = await createTestClient()
    const collected = await collect(
      ace.sites.iterateTimeseries("acme_north_campus", { ...RANGE, pageSize: pageSize as 50 })
    )

    expect(collected.map(sampleKey)).toEqual(samples.map(sampleKey))
    expect(requests).toBe(Math.ceil(3222 / pageSize))
  })

  test.each([
    [
      // ACE answers {offset: 2} here too: the page ended two rows into a new bucket.
      "is inert when a page crosses into a later bucket",
      { offset: 1000, timestamp: "2026-08-07T17:15:00" },
      [
        sample("a", "2026-08-07T17:15:00"),
        sample("b", "2026-08-07T17:20:00"),
        sample("c", "2026-08-07T17:20:00"),
      ],
      true,
      { offset: 2, timestamp: "2026-08-07T17:20:00" },
    ],
    [
      // ACE answers {offset: 2} here, the offset it was handed back unchanged.
      "carries the incoming offset when a page stays inside one bucket",
      { offset: 50, timestamp: "2026-08-07T17:15:00" },
      [sample("a", "2026-08-07T17:15:00"), sample("b", "2026-08-07T17:15:00")],
      true,
      { offset: 52, timestamp: "2026-08-07T17:15:00" },
    ],
    [
      "counts from zero when the incoming cursor does not decode",
      "not-base64-json",
      [sample("a", "2026-08-07T17:15:00")],
      true,
      { offset: 1, timestamp: "2026-08-07T17:15:00" },
    ],
    [
      "yields no cursor for a terminal page",
      null,
      [sample("a", "2026-08-07T17:15:00")],
      false,
      null,
    ],
    ["yields no cursor for an empty page", null, [], true, null],
  ] as const)("the repair %s", (_name, incoming, samples, hasMore, expected) => {
    const pageResult: AceIotTimeseriesPage = {
      point_samples: [...samples],
      next_cursor: "ace-cursor",
      has_more: hasMore,
    }
    const incomingCursor =
      incoming === null || typeof incoming === "string"
        ? incoming
        : encodeTimeseriesCursor(incoming)

    const repaired = repairTimeseriesCursor(incomingCursor, pageResult)

    expect(repaired === null ? null : decodeTimeseriesCursor(repaired)).toEqual(expected)
  })

  test("maxPages bounds the walk", async () => {
    const samples = buildSamples(BUCKETS)
    const server = aceTimeseriesServer(samples)
    mockFetch((input) => Promise.resolve(json(server(new URL(String(input))))))

    const ace = await createTestClient()
    const collected = await collect(
      ace.sites.iterateTimeseries("site", { ...RANGE, pageSize: 50, maxPages: 3 })
    )

    expect(collected).toHaveLength(150)
  })

  test("a walk that stops advancing is reported instead of looped on", async () => {
    // A server that keeps claiming more data while ignoring the cursor entirely. Guarding on
    // repeated cursors would not catch this: the repaired cursor advances on every hop.
    let calls = 0
    mockFetch(() => {
      calls += 1
      return Promise.resolve(
        json({
          point_samples: [{ name: "a", value: "1", time: "2026-08-07T17:15:00" }],
          next_cursor: encodeTimeseriesCursor({ offset: 1, timestamp: "2026-08-07T17:15:00" }),
          has_more: true,
        })
      )
    })

    const ace = await createTestClient()
    const walk = collect(ace.sites.iterateTimeseries("site", { ...RANGE, pageSize: 3 }))

    await expect(walk).rejects.toThrow(
      "[SixbAceIot] Timeseries pagination returned the same page twice and would not advance."
    )
    expect(calls).toBe(2)
  })

  test("cursors round-trip through base64 JSON and reject malformed input", () => {
    const cursor = { offset: 50, timestamp: "2026-08-07T17:15:00" }
    expect(decodeTimeseriesCursor(encodeTimeseriesCursor(cursor))).toEqual(cursor)
    // The exact wire value ACE returns, so the encoding is pinned, not merely self-consistent.
    expect(encodeTimeseriesCursor(cursor)).toBe(
      "eyJvZmZzZXQiOjUwLCJ0aW1lc3RhbXAiOiIyMDI2LTA4LTA3VDE3OjE1OjAwIn0="
    )
    expect(
      decodeTimeseriesCursor("eyJvZmZzZXQiOiA1MCwgInRpbWVzdGFtcCI6ICIyMDI2LTA4LTA3VDE3OjE1OjAwIn0=")
    ).toEqual(cursor)
    expect(decodeTimeseriesCursor("garbage")).toBeNull()
    expect(decodeTimeseriesCursor(btoa("[]"))).toBeNull()
    expect(decodeTimeseriesCursor(btoa(JSON.stringify({ offset: -1, timestamp: "x" })))).toBeNull()
  })
})

describe("page walking", () => {
  test("listAll follows page numbers and stops on the last page", async () => {
    const urls: URL[] = []
    mockFetch((input) => {
      const url = new URL(String(input))
      urls.push(url)
      const pageNumber = Number(url.searchParams.get("page"))
      return Promise.resolve(
        json(
          page([{ id: pageNumber, name: `site-${pageNumber}` }], {
            page: pageNumber,
            pages: 3,
            per_page: 1,
            total: 3,
          })
        )
      )
    })

    const ace = await createTestClient()
    const sites = await collect(ace.sites.listAll({ perPage: 2 }))

    expect(sites.map((site) => site.name)).toEqual(["site-1", "site-2", "site-3"])
    expect(urls.map((url) => url.searchParams.get("page"))).toEqual(["1", "2", "3"])
    expect(urls[0].searchParams.get("per_page")).toBe("2")
  })

  test.each([
    [
      // `pages` cannot be the only stop condition: the PCAP listing answers `"pages": null`.
      "an empty page when `pages` is null",
      (ace: AceIotClient) =>
        ace.gateways.listAllPcapFiles("gw", {
          perPage: 2,
          startTime: "2026-08-01T00:00:00Z",
          endTime: "2026-08-07T00:00:00Z",
        }),
      (call: number) =>
        page(call === 1 ? ["a.pcap", "b.pcap"] : [], { pages: null, per_page: 2, total: 4 }),
      { items: 2, calls: 2, perPage: "2" },
    ],
    [
      "a short page, without spending another request",
      (ace: AceIotClient) => ace.sites.listAll({ perPage: 10 }),
      () => page([{ id: 1 }], { pages: 9, per_page: 10, total: 90 }),
      { items: 1, calls: 1, perPage: "10" },
    ],
    [
      "maxPages, at the default page size",
      (ace: AceIotClient) => ace.points.listAll({ maxPages: 4 }),
      () => page([{ id: 1 }, { id: 2 }], { pages: 50, per_page: 2, total: 100 }),
      { items: 8, calls: 4, perPage: "1000" },
    ],
  ] as const)("listAll stops on %s", async (_name, walk, respond, expected) => {
    const urls: URL[] = []
    mockFetch((input) => {
      urls.push(new URL(String(input)))
      return Promise.resolve(json(respond(urls.length)))
    })

    const ace = await createTestClient()
    const items = await collect<unknown>(walk(ace))

    expect(items).toHaveLength(expected.items)
    expect(urls).toHaveLength(expected.calls)
    // listAll asks for 1000 rows a page unless told otherwise; ACE's own default is 10.
    expect(urls[0].searchParams.get("per_page")).toBe(expected.perPage)
  })
})
