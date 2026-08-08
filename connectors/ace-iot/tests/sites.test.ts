import { afterEach, describe, expect, test } from "bun:test"
import type { AceIotPoint, AceIotSite } from "../src"
import { captureFetch, collect, createTestClient, json, mockFetch, page } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** A site exactly as the live API returns one, including the fields that come back null. */
const SITE: AceIotSite = {
  id: 10,
  name: "acme_north_campus",
  client: "acme",
  address: null,
  nice_name: "Acme North Campus",
  ansible_user: null,
  vtron_user: null,
  vtron_ip: null,
  geo_location: "0101000000000000000000f03f000000000000f03f",
  mqtt_prefix: null,
  latitude: 40.7128,
  longitude: -74.006,
  archived: false,
}

const POINT: AceIotPoint = {
  id: 4001,
  name: "acme/acme_north_campus/10.0.0.10-100/analogInput/1",
  client: "acme",
  site: "acme_north_campus",
  kv_tags: { vav: "VAV2_5", type: "Room Temp" },
  bacnet_data: {
    device_address: "10.0.0.10",
    device_id: 100,
    object_type: "analogInput",
    object_index: 1,
    object_name: "Network.SupplyAirTemp",
    device_name: "Controller-100",
    object_units: "degrees-fahrenheit",
    present_value: "38.78239822387695",
    scrape_enabled: true,
    scrape_interval: 300,
    vendor_name: "ExampleVendor",
    // A property the device did not answer for. ACE sends this literal string, not null.
    model_name: "property: unknown-property",
  },
  marker_tags: [],
  collect_config: {},
  point_type: null,
  collect_enabled: true,
  collect_interval: 300,
  updated: "2025-12-01T23:46:12.058246",
  created: "2024-02-14T19:43:07.623281",
}

describe("sites", () => {
  test("list sends both flags and returns ACE's page envelope untouched", async () => {
    const { urls } = captureFetch(page([SITE], { per_page: 50, total: 3, pages: 1 }))
    const ace = await createTestClient()

    const result = await ace.sites.list({
      page: 1,
      perPage: 50,
      collectEnabled: true,
      showArchived: true,
    })

    expect(urls[0].pathname).toBe("/api/sites/")
    expect(urls[0].searchParams.get("page")).toBe("1")
    expect(urls[0].searchParams.get("per_page")).toBe("50")
    expect(urls[0].searchParams.get("collect_enabled")).toBe("true")
    expect(urls[0].searchParams.get("show_archived")).toBe("true")
    expect(result.items[0]).toEqual(SITE)
    expect(result.total).toBe(3)
  })

  test("omitted flags are not sent, so ACE applies its own defaults", async () => {
    const { urls } = captureFetch(page([SITE]))
    const ace = await createTestClient()

    await ace.sites.list()

    expect(urls[0].search).toBe("")
  })

  test("get encodes the site name", async () => {
    const { urls } = captureFetch(SITE)
    const ace = await createTestClient()

    const site = await ace.sites.get("acme north/campus")

    expect(urls[0].pathname).toBe("/api/sites/acme%20north%2Fcampus")
    expect(site).toEqual(SITE)
  })

  test("listPoints and listConfiguredPoints hit their own routes", async () => {
    const { urls } = captureFetch(page([POINT]))
    const ace = await createTestClient()

    await ace.sites.listPoints("acme_north_campus", { perPage: 1000 })
    await ace.sites.listConfiguredPoints("acme_north_campus", { perPage: 1000 })

    expect(urls[0].pathname).toBe("/api/sites/acme_north_campus/points")
    expect(urls[1].pathname).toBe("/api/sites/acme_north_campus/configured_points")
  })

  test("a point keeps every bacnet property, including ones ACE's schema omits", async () => {
    captureFetch(page([POINT]))
    const ace = await createTestClient()

    const result = await ace.sites.listPoints("site")
    const point = result.items[0]

    expect(point.bacnet_data.vendor_name).toBe("ExampleVendor")
    expect(point.bacnet_data.device_id).toBe(100)
    expect(point.bacnet_data.scrape_enabled).toBe(true)
    expect(point.bacnet_data.model_name).toBe("property: unknown-property")
    expect(point.kv_tags).toEqual({ vav: "VAV2_5", type: "Room Temp" })
    expect(point.point_type).toBeNull()
  })

  test("getTimeseries returns the whole window in one response", async () => {
    const samples = [
      {
        name: "acme/acme_north_campus/10.0.0.10-100/analogInput/1",
        value: "1.6100000143051147",
        time: "2026-08-07T16:25:00",
      },
    ]
    const { urls } = captureFetch({ point_samples: samples })
    const ace = await createTestClient()

    const result = await ace.sites.getTimeseries("site", {
      startTime: "2026-08-07T16:00:00Z",
      endTime: "2026-08-07T17:00:00Z",
    })

    expect(urls[0].pathname).toBe("/api/sites/site/timeseries")
    expect(result.point_samples).toEqual(samples)
    // Numeric-looking readings stay strings, so no rounding is introduced.
    expect(result.point_samples[0].value).toBe("1.6100000143051147")
  })

  test("getTimeseriesPage forwards cursor, page size, and raw_data", async () => {
    const { urls } = captureFetch({ point_samples: [], next_cursor: null, has_more: false })
    const ace = await createTestClient()

    await ace.sites.getTimeseriesPage("site", {
      startTime: "2026-08-07T16:00:00Z",
      endTime: "2026-08-07T17:00:00Z",
      cursor: "eyJvZmZzZXQiOiA1MH0=",
      pageSize: 50000,
      rawData: true,
    })

    expect(urls[0].pathname).toBe("/api/sites/site/timeseries/paginated")
    expect(urls[0].searchParams.get("cursor")).toBe("eyJvZmZzZXQiOiA1MH0=")
    expect(urls[0].searchParams.get("page_size")).toBe("50000")
    expect(urls[0].searchParams.get("raw_data")).toBe("true")
  })

  test("an empty window is an empty page, not an error", async () => {
    // ACE's schema documents 404 here; the live API answers 200 with an empty list.
    captureFetch({ point_samples: [], next_cursor: null, has_more: false })
    const ace = await createTestClient()

    const collected = await collect(
      ace.sites.iterateTimeseries("site", {
        startTime: "2001-01-01T00:00:00Z",
        endTime: "2001-01-01T01:00:00Z",
      })
    )

    expect(collected).toEqual([])
  })

  test("appendTimeseries posts the sample list", async () => {
    const { urls, inits } = captureFetch(undefined)
    const ace = await createTestClient()

    await ace.sites.appendTimeseries("site", {
      point_samples: [{ name: "site/p", value: "1.5", time: "2026-08-07T16:25:00" }],
    })

    expect(inits[0].method).toBe("POST")
    expect(urls[0].pathname).toBe("/api/sites/site/timeseries")
    expect(JSON.parse(String(inits[0].body))).toEqual({
      point_samples: [{ name: "site/p", value: "1.5", time: "2026-08-07T16:25:00" }],
    })
  })

  test("getWeather unwraps the envelope", async () => {
    const weather = {
      temp: { name: "site/weather/temp", value: "31.29", time: "2026-08-07T17:16:34.957381" },
      feels_like: {
        name: "site/weather/feels_like",
        value: "37.76",
        time: "2026-08-07T17:16:34.957381",
      },
      pressure: {
        name: "site/weather/pressure",
        value: "1020",
        time: "2026-08-07T17:16:34.957381",
      },
      humidity: { name: "site/weather/humidity", value: "62", time: "2026-08-07T17:16:34.957381" },
      dew_point: {
        name: "site/weather/dew_point",
        value: "23.4",
        time: "2026-08-07T17:16:34.957381",
      },
      clouds: { name: "site/weather/clouds", value: "40", time: "2026-08-07T17:16:34.957381" },
      wind_speed: {
        name: "site/weather/wind_speed",
        value: "3.1",
        time: "2026-08-07T17:16:34.957381",
      },
      wind_deg: { name: "site/weather/wind_deg", value: "180", time: "2026-08-07T17:16:34.957381" },
      wet_bulb: {
        name: "site/weather/wet_bulb",
        value: "25.1",
        time: "2026-08-07T17:16:34.957381",
      },
    }
    const { urls } = captureFetch({ weather })
    const ace = await createTestClient()

    const result = await ace.sites.getWeather("site")

    expect(urls[0].pathname).toBe("/api/sites/site/weather")
    expect(result?.temp.value).toBe("31.29")
  })

  test("a site with no weather feed answers null rather than throwing", async () => {
    // The live API returns 404 with an all-null body for a site that has no weather points.
    mockFetch(async () =>
      json({ weather: { temp: { name: null, value: null, time: null } } }, { status: 404 })
    )
    const ace = await createTestClient({ retry: { maxRetries: 0 } })

    expect(await ace.sites.getWeather("acme_west_campus")).toBeNull()
  })

  test("a weather failure that is not a 404 still throws", async () => {
    mockFetch(async () => json({ message: "Boom" }, { status: 500 }))
    const ace = await createTestClient({ retry: { maxRetries: 0 } })

    await expect(ace.sites.getWeather("site")).rejects.toThrow("failed with 500")
  })
})
