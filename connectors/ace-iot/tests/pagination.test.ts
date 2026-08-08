import { afterEach, describe, expect, test } from "bun:test"
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

describe("timeseries cursor repair", () => {
  test("the fixture reproduces ACE's stall, so the repair below is not testing an already-working server", async () => {
    // Guard proof: walking with the server's own next_cursor, which is what a plain
    // `while (has_more)` loop does. Revert `repairTimeseriesCursor` to return `page.next_cursor`
    // and the coverage test below fails exactly like this.
    const samples = buildSamples(BUCKETS)
    const server = aceTimeseriesServer(samples)

    let cursor: string | null = null
    const seen = new Set<string>()
    const collected: string[] = []
    let pages = 0
    let stalled = false

    for (;;) {
      const url = new URL("https://ace.test/api/sites/s/timeseries/paginated")
      url.searchParams.set("page_size", "50")
      if (cursor) url.searchParams.set("cursor", cursor)

      const result = server(url)
      pages += 1
      collected.push(...result.point_samples.map(sampleKey))

      if (!result.has_more || !result.next_cursor) break
      if (seen.has(result.next_cursor)) {
        stalled = true
        break
      }
      seen.add(result.next_cursor)
      cursor = result.next_cursor
    }

    expect(stalled).toBe(true)
    // The walk reaches 100 rows of 3,222 and then re-requests page 2 forever — the numbers
    // measured against the live API.
    expect(pages).toBe(2)
    expect(new Set(collected).size).toBe(100)
    expect(samples.length).toBe(3222)
  })

  test("iterateTimeseries walks the whole window at a page size that stalls ACE's own cursor", async () => {
    const samples = buildSamples(BUCKETS)
    const server = aceTimeseriesServer(samples)
    let requests = 0
    mockFetch((input) => {
      requests += 1
      return Promise.resolve(json(server(new URL(String(input)))))
    })

    const ace = await createTestClient()
    const collected = await collect(
      ace.sites.iterateTimeseries("acme_north_campus", { ...RANGE, pageSize: 50 })
    )

    expect(collected).toHaveLength(3222)
    expect(new Set(collected.map(sampleKey)).size).toBe(3222)
    expect(collected.map(sampleKey)).toEqual(samples.map(sampleKey))
    expect(requests).toBe(Math.ceil(3222 / 50))
  })

  test.each([
    3, 10, 50, 100, 500, 1000, 5000,
  ])("page size %i yields every sample exactly once", async (pageSize) => {
    const samples = buildSamples(BUCKETS)
    const server = aceTimeseriesServer(samples)
    mockFetch((input) => Promise.resolve(json(server(new URL(String(input))))))

    const ace = await createTestClient()
    const collected = await collect(
      ace.sites.iterateTimeseries("site", {
        ...RANGE,
        pageSize: pageSize as 50,
      })
    )

    expect(collected.map(sampleKey)).toEqual(samples.map(sampleKey))
  })

  test("the repair is inert when a page crosses into a later bucket, where ACE's cursor is correct", () => {
    // Page ends 536 rows into a new bucket: ACE returns {offset: 536} and so does the repair.
    const pageResult = {
      point_samples: [
        { name: "a", value: "1", time: "2026-08-07T17:15:00" },
        { name: "b", value: "2", time: "2026-08-07T17:20:00" },
        { name: "c", value: "3", time: "2026-08-07T17:20:00" },
      ],
      next_cursor: encodeTimeseriesCursor({ offset: 2, timestamp: "2026-08-07T17:20:00" }),
      has_more: true,
    }
    const incoming = encodeTimeseriesCursor({ offset: 1000, timestamp: "2026-08-07T17:15:00" })

    expect(decodeTimeseriesCursor(repairTimeseriesCursor(incoming, pageResult) ?? "")).toEqual({
      offset: 2,
      timestamp: "2026-08-07T17:20:00",
    })
    expect(repairTimeseriesCursor(incoming, pageResult)).toBe(pageResult.next_cursor)
  })

  test("the repair carries the incoming offset when a page stays inside one bucket", () => {
    const pageResult = {
      point_samples: [
        { name: "a", value: "1", time: "2026-08-07T17:15:00" },
        { name: "b", value: "2", time: "2026-08-07T17:15:00" },
      ],
      // What ACE actually sends back: the offset it was given, unchanged.
      next_cursor: encodeTimeseriesCursor({ offset: 2, timestamp: "2026-08-07T17:15:00" }),
      has_more: true,
    }
    const incoming = encodeTimeseriesCursor({ offset: 50, timestamp: "2026-08-07T17:15:00" })

    expect(decodeTimeseriesCursor(repairTimeseriesCursor(incoming, pageResult) ?? "")).toEqual({
      offset: 52,
      timestamp: "2026-08-07T17:15:00",
    })
  })

  test("a terminal page yields no cursor", () => {
    const samples = [{ name: "a", value: "1", time: "2026-08-07T17:15:00" }]
    expect(
      repairTimeseriesCursor(null, { point_samples: samples, next_cursor: "x", has_more: false })
    ).toBeNull()
    expect(
      repairTimeseriesCursor(null, { point_samples: [], next_cursor: "x", has_more: true })
    ).toBeNull()
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

  test("an opaque cursor that does not decode still terminates rather than looping", async () => {
    let calls = 0
    mockFetch(() => {
      calls += 1
      return Promise.resolve(
        json({
          point_samples:
            calls === 1 ? [{ name: "a", value: "1", time: "2026-08-07T17:15:00" }] : [],
          next_cursor: "not-base64-json",
          has_more: calls === 1,
        })
      )
    })

    const ace = await createTestClient()
    const collected = await collect(
      ace.sites.iterateTimeseries("site", { ...RANGE, cursor: "garbage", pageSize: 3 })
    )

    expect(collected).toHaveLength(1)
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

  test("listAll defaults to a page size worth walking with", async () => {
    const urls: URL[] = []
    mockFetch((input) => {
      urls.push(new URL(String(input)))
      return Promise.resolve(json(page([])))
    })

    const ace = await createTestClient()
    await collect(ace.sites.listAll())

    expect(urls[0].searchParams.get("per_page")).toBe("1000")
  })

  test("listAll stops on a null `pages`, which the PCAP listing returns", async () => {
    let calls = 0
    mockFetch(() => {
      calls += 1
      return Promise.resolve(
        json(page(calls === 1 ? ["a.pcap", "b.pcap"] : [], { pages: null, per_page: 2, total: 4 }))
      )
    })

    const ace = await createTestClient()
    const files = await collect(
      ace.gateways.listAllPcapFiles("gw", {
        perPage: 2,
        startTime: "2026-08-01T00:00:00Z",
        endTime: "2026-08-07T00:00:00Z",
      })
    )

    expect(files).toEqual(["a.pcap", "b.pcap"])
    expect(calls).toBe(2)
  })

  test("listAll stops on a short page without spending another request", async () => {
    let calls = 0
    mockFetch(() => {
      calls += 1
      return Promise.resolve(json(page([{ id: 1 }], { pages: 9, per_page: 10, total: 90 })))
    })

    const ace = await createTestClient()
    await collect(ace.sites.listAll({ perPage: 10 }))

    expect(calls).toBe(1)
  })

  test("listAll honors maxPages", async () => {
    mockFetch(() =>
      Promise.resolve(json(page([{ id: 1 }, { id: 2 }], { pages: 50, per_page: 2, total: 100 })))
    )

    const ace = await createTestClient()
    const points = await collect(ace.points.listAll({ perPage: 2, maxPages: 4 }))

    expect(points).toHaveLength(8)
  })
})
