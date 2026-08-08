import { afterEach, describe, expect, test } from "bun:test"
import { captureFetch, collect, createTestClient } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const POINT_NAME = "acme/acme_north_campus/10.0.0.10-100/analogInput/1"
const RANGE = { startTime: "2026-08-07T16:00:00Z", endTime: "2026-08-07T17:00:00Z" }

describe("points", () => {
  test("get percent-encodes the slashes in a point name", async () => {
    const { urls } = captureFetch({ id: 1, name: POINT_NAME })
    const ace = await createTestClient()

    await ace.points.get(POINT_NAME)

    // Left unencoded, this would route to a different endpoint entirely.
    expect(urls[0].pathname).toBe(
      "/api/points/acme%2Facme_north_campus%2F10.0.0.10-100%2FanalogInput%2F1"
    )
  })

  test("list walks the global point collection", async () => {
    const { urls } = captureFetch({
      items: [{ id: 1, name: POINT_NAME }],
      page: 1,
      pages: 8756,
      per_page: 10,
      total: 87559,
    })
    const ace = await createTestClient()

    const result = await ace.points.list({ perPage: 10 })

    expect(urls[0].pathname).toBe("/api/points/")
    expect(result.total).toBe(87559)
    expect(result.pages).toBe(8756)
  })

  test("create posts a point list and defaults to merging tags", async () => {
    const { urls, inits } = captureFetch(undefined)
    const ace = await createTestClient()

    await ace.points.create([{ name: POINT_NAME, collect_enabled: true, collect_interval: 300 }])

    expect(inits[0].method).toBe("POST")
    expect(urls[0].pathname).toBe("/api/points/")
    expect(urls[0].searchParams.get("overwrite_m_tags")).toBeNull()
    expect(urls[0].searchParams.get("overwrite_kv_tags")).toBeNull()
    expect(JSON.parse(String(inits[0].body))).toEqual({
      points: [{ name: POINT_NAME, collect_enabled: true, collect_interval: 300 }],
    })
  })

  test("tag overwrite flags map to ACE's parameter names", async () => {
    const { urls } = captureFetch(undefined)
    const ace = await createTestClient()

    await ace.points.update(
      POINT_NAME,
      { name: POINT_NAME, kv_tags: { vav: "VAV2_5" }, marker_tags: ["sensor"] },
      { overwriteMarkerTags: true, overwriteKvTags: true }
    )

    expect(urls[0].searchParams.get("overwrite_m_tags")).toBe("true")
    expect(urls[0].searchParams.get("overwrite_kv_tags")).toBe("true")
  })

  test("update targets the named point with PUT", async () => {
    const { urls, inits } = captureFetch(undefined)
    const ace = await createTestClient()

    await ace.points.update(POINT_NAME, { name: POINT_NAME, collect_enabled: false })

    expect(inits[0].method).toBe("PUT")
    expect(urls[0].pathname).toContain("/api/points/acme%2F")
  })

  test("getTimeseries reads one point's window", async () => {
    const { urls } = captureFetch({ point_samples: [] })
    const ace = await createTestClient()

    await ace.points.getTimeseries(POINT_NAME, RANGE)

    expect(urls[0].pathname).toMatch(/\/api\/points\/.+\/timeseries$/)
    expect(urls[0].searchParams.get("start_time")).toBe("2026-08-07T16:00:00Z")
  })

  test("getTimeseriesForPoints wraps names in ACE's point-list body", async () => {
    const { urls, inits } = captureFetch({ point_samples: [] })
    const ace = await createTestClient()

    await ace.points.getTimeseriesForPoints([POINT_NAME, "other/point"], RANGE)

    expect(inits[0].method).toBe("POST")
    expect(urls[0].pathname).toBe("/api/points/get_timeseries")
    expect(urls[0].searchParams.get("start_time")).toBe("2026-08-07T16:00:00Z")
    expect(urls[0].searchParams.get("end_time")).toBe("2026-08-07T17:00:00Z")
    expect(JSON.parse(String(inits[0].body))).toEqual({
      points: [{ name: POINT_NAME }, { name: "other/point" }],
    })
  })

  test("listAll walks pages of the global collection", async () => {
    let calls = 0
    const { urls } = captureFetch(null)
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1
      urls.push(new URL(String(input)))
      return new Response(
        JSON.stringify({
          items:
            calls <= 2
              ? [
                  { id: calls, name: `p${calls}` },
                  { id: calls, name: `q${calls}` },
                ]
              : [],
          page: calls,
          pages: 3,
          per_page: 2,
          total: 6,
        }),
        { headers: { "content-type": "application/json" } }
      )
    }) as typeof fetch

    const ace = await createTestClient()
    const points = await collect(ace.points.listAll({ perPage: 2 }))

    expect(points).toHaveLength(4)
    expect(calls).toBe(3)
  })
})
