import { afterEach, describe, expect, test } from "bun:test"
import {
  ACE_IOT_PAGE_SIZE_VALUES,
  ACE_IOT_PER_PAGE_VALUES,
  normalizeAceIotTimestamp,
  parseAceIotTimestamp,
} from "../src"
import { captureFetch, createTestClient, json, mockFetch, page } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("page size enums", () => {
  test("the two enums are what ACE accepts, and they differ", () => {
    expect([...ACE_IOT_PER_PAGE_VALUES]).toEqual([
      2, 10, 20, 30, 40, 50, 100, 500, 1000, 5000, 10000, 100000,
    ])
    expect([...ACE_IOT_PAGE_SIZE_VALUES]).toEqual([
      3, 10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000, 300000, 500000,
    ])
    // The timeseries endpoint takes 3 and rejects 2; the list endpoints do the opposite.
    expect(ACE_IOT_PER_PAGE_VALUES).toContain(2)
    expect(ACE_IOT_PER_PAGE_VALUES).not.toContain(3)
    expect(ACE_IOT_PAGE_SIZE_VALUES).toContain(3)
    expect(ACE_IOT_PAGE_SIZE_VALUES).not.toContain(2)
  })

  test("an unsupported perPage is rejected locally instead of spending a 400", async () => {
    let calls = 0
    mockFetch(async () => {
      calls += 1
      return json(page([]))
    })
    const ace = await createTestClient()

    expect(() => ace.sites.list({ perPage: 25 as 20 })).toThrow(
      "[SixbAceIot] perPage must be one of 2, 10, 20, 30, 40, 50, 100, 500, 1000, 5000, 10000, 100000. Received 25."
    )
    expect(calls).toBe(0)
  })

  test("an unsupported timeseries pageSize is rejected locally", async () => {
    const ace = await createTestClient()

    expect(() =>
      ace.sites.getTimeseriesPage("site", {
        startTime: "2026-08-07T17:00:00Z",
        endTime: "2026-08-07T18:00:00Z",
        pageSize: 2 as 3,
      })
    ).toThrow("[SixbAceIot] pageSize must be one of 3, 10, 50")
  })

  test("page and maxPages must be positive integers", async () => {
    const ace = await createTestClient()

    expect(() => ace.sites.list({ page: 0 })).toThrow(
      "[SixbAceIot] page must be an integer greater than 0."
    )
    expect(() => ace.sites.list({ page: 1.5 })).toThrow(
      "[SixbAceIot] page must be an integer greater than 0."
    )
    expect(() => ace.sites.listAll({ maxPages: 0 })).toThrow(
      "[SixbAceIot] maxPages must be an integer greater than 0."
    )
  })

  test("an empty path identifier is rejected with the parameter name", async () => {
    const ace = await createTestClient()

    expect(() => ace.sites.get("  ")).toThrow("[SixbAceIot] siteName must be a non-empty string.")
    expect(() => ace.points.get("")).toThrow("[SixbAceIot] pointName must be a non-empty string.")
    expect(() => ace.gateways.get("")).toThrow(
      "[SixbAceIot] gatewayName must be a non-empty string."
    )
  })
})

describe("naive UTC timestamps", () => {
  test("a zoneless ACE timestamp parses as UTC, not as host-local time", () => {
    // The whole point: `new Date("2026-08-07T16:25:00")` is host-local and would shift the sample.
    expect(parseAceIotTimestamp("2026-08-07T16:25:00").toISOString()).toBe(
      "2026-08-07T16:25:00.000Z"
    )
  })

  test("microseconds truncate to milliseconds, which is all a Date holds", () => {
    expect(parseAceIotTimestamp("2026-08-07T16:25:00.627593").toISOString()).toBe(
      "2026-08-07T16:25:00.627Z"
    )
  })

  test("the space-separated form gateways use for device_token_expires is handled", () => {
    expect(parseAceIotTimestamp("2027-03-04 19:34:54.114795").toISOString()).toBe(
      "2027-03-04T19:34:54.114Z"
    )
  })

  test("a timestamp that already carries a zone is left alone", () => {
    expect(parseAceIotTimestamp("2026-08-07T16:25:00Z").toISOString()).toBe(
      "2026-08-07T16:25:00.000Z"
    )
    expect(parseAceIotTimestamp("2026-08-07T18:25:00+02:00").toISOString()).toBe(
      "2026-08-07T16:25:00.000Z"
    )
  })

  test("normalize exposes the same rule without building a Date", () => {
    expect(normalizeAceIotTimestamp("2026-08-07T16:25:00")).toBe("2026-08-07T16:25:00Z")
    expect(normalizeAceIotTimestamp("2027-03-04 19:34:54.114795")).toBe(
      "2027-03-04T19:34:54.114795Z"
    )
  })

  test("unparseable input is reported rather than returning an Invalid Date", () => {
    expect(() => parseAceIotTimestamp("not a time")).toThrow(
      '[SixbAceIot] Could not parse "not a time" as a timestamp.'
    )
    expect(() => parseAceIotTimestamp("")).toThrow(
      "[SixbAceIot] A timestamp must be a non-empty string."
    )
  })
})

describe("time range query serialization", () => {
  test("a Date becomes UTC ISO", async () => {
    const { urls } = captureFetch({ point_samples: [] })
    const ace = await createTestClient()

    await ace.sites.getTimeseries("site", {
      startTime: new Date("2026-08-07T17:00:00Z"),
      endTime: new Date("2026-08-07T18:00:00Z"),
    })

    expect(urls[0].searchParams.get("start_time")).toBe("2026-08-07T17:00:00.000Z")
    expect(urls[0].searchParams.get("end_time")).toBe("2026-08-07T18:00:00.000Z")
  })

  test("a naive timestamp read off a response can be handed straight back as a bound", async () => {
    const { urls } = captureFetch({ point_samples: [] })
    const ace = await createTestClient()

    // "2026-08-07T16:25:00" is what a sample carries. It must not shift by the host offset.
    await ace.sites.getTimeseries("site", {
      startTime: "2026-08-07T16:25:00",
      endTime: "2026-08-07T17:25:00",
    })

    expect(urls[0].searchParams.get("start_time")).toBe("2026-08-07T16:25:00Z")
    expect(urls[0].searchParams.get("end_time")).toBe("2026-08-07T17:25:00Z")
  })

  test("an invalid Date is rejected before the request", async () => {
    const ace = await createTestClient()

    expect(() =>
      ace.sites.getTimeseries("site", {
        startTime: new Date("nonsense"),
        endTime: new Date(),
      })
    ).toThrow("[SixbAceIot] startTime must be a valid Date.")
  })
})
