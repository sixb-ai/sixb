import { afterEach, describe, expect, test } from "bun:test"
import { normalizeAceIotTimestamp, parseAceIotTimestamp } from "../src"
import { captureFetch, createTestClient, json, mockFetch, page } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("page size enums", () => {
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

    // The timeseries endpoint takes a different enum: 3 but not 2, the opposite of `per_page`.
    expect(() =>
      ace.sites.getTimeseriesPage("site", {
        startTime: "2026-08-07T17:00:00Z",
        endTime: "2026-08-07T18:00:00Z",
        pageSize: 2 as 3,
      })
    ).toThrow(
      "[SixbAceIot] pageSize must be one of 3, 10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000, 300000, 500000. Received 2."
    )
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
  test.each([
    // `new Date("2026-08-07T16:25:00")` is host-local and would shift the sample.
    ["a zoneless timestamp as UTC", "2026-08-07T16:25:00", "2026-08-07T16:25:00.000Z"],
    [
      "microseconds truncated to milliseconds",
      "2026-08-07T16:25:00.627593",
      "2026-08-07T16:25:00.627Z",
    ],
    // Gateways use this form for device_token_expires.
    ["the space-separated form as UTC", "2027-03-04 19:34:54.114795", "2027-03-04T19:34:54.114Z"],
    ["a Z timestamp unchanged", "2026-08-07T16:25:00Z", "2026-08-07T16:25:00.000Z"],
    ["an offset timestamp unchanged", "2026-08-07T18:25:00+02:00", "2026-08-07T16:25:00.000Z"],
  ])("parseAceIotTimestamp reads %s", (_name, value, expected) => {
    expect(parseAceIotTimestamp(value).toISOString()).toBe(expected)
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
  test.each([
    [
      "a Date as UTC ISO",
      { startTime: new Date("2026-08-07T17:00:00Z"), endTime: new Date("2026-08-07T18:00:00Z") },
      ["2026-08-07T17:00:00.000Z", "2026-08-07T18:00:00.000Z"],
    ],
    [
      // What a sample carries, handed straight back as a bound without shifting by the host offset.
      "a naive timestamp read off a response as UTC",
      { startTime: "2026-08-07T16:25:00", endTime: "2026-08-07T17:25:00" },
      ["2026-08-07T16:25:00Z", "2026-08-07T17:25:00Z"],
    ],
  ])("the range serializes %s", async (_name, range, [startTime, endTime]) => {
    const { urls } = captureFetch({ point_samples: [] })
    const ace = await createTestClient()

    await ace.sites.getTimeseries("site", range)

    expect(urls[0].searchParams.get("start_time")).toBe(startTime)
    expect(urls[0].searchParams.get("end_time")).toBe(endTime)
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
