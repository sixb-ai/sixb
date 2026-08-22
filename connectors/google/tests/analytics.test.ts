import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { google } from "../src/google"
import type { GoogleClient } from "../src/index"
import { CONTEXT, collect, json, mockFetch, restoreFetch } from "./helpers"

const ADMIN_BASE = "https://analyticsadmin.googleapis.com/v1beta/"
const DATA_BASE = "https://analyticsdata.googleapis.com/v1beta/"

interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly auth: string | null
  readonly body: unknown
}

let requests: RecordedRequest[]

async function connect(options?: { readonly retry?: boolean }): Promise<GoogleClient> {
  return google({
    auth: { token: () => "analytics-token" },
    retry: options?.retry ? { maxRetries: 1, delayMs: () => 0 } : { maxRetries: 0 },
  }).connect(CONTEXT)
}

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
    method: String(init?.method ?? "GET"),
    auth: new Headers(init?.headers).get("authorization"),
    body,
  })
}

function expectRequest(
  index: number,
  base: string,
  method: string,
  path: string,
  body?: unknown
): void {
  const request = requests[index]
  expect(request?.url).toBe(`${base}${path}`)
  expect(request?.method).toBe(method)
  expect(request?.auth).toBe("Bearer analytics-token")
  if (body !== undefined) {
    expect(request?.body).toEqual(body)
  }
}

beforeEach(() => {
  requests = []
})

afterEach(restoreFetch)

describe("analytics.admin", () => {
  test("discovers every account summary and property page", async () => {
    const responses = [
      {
        accountSummaries: [
          {
            account: "accounts/1",
            propertySummaries: [{ property: "properties/10", displayName: "Store" }],
          },
        ],
        nextPageToken: "accounts-2",
      },
      { accountSummaries: [{ account: "accounts/2" }] },
      { properties: [{ name: "properties/10" }], nextPageToken: "properties-2" },
      { properties: [{ name: "properties/11" }] },
    ]
    let call = 0
    mockFetch(async (input, init) => {
      record(input, init)
      return json(responses[call++])
    })

    const admin = (await connect()).analytics.admin
    const summaries = await collect(admin.accountSummaries.listAll({ pageSize: 1 }))
    const properties = await collect(
      admin.properties.listAll({ filter: "ancestor:accounts/1", pageSize: 1 })
    )

    expect(summaries.map((summary) => summary.account)).toEqual(["accounts/1", "accounts/2"])
    expect(properties.map((property) => property.name)).toEqual(["properties/10", "properties/11"])
    expectRequest(0, ADMIN_BASE, "GET", "accountSummaries?pageSize=1")
    expectRequest(1, ADMIN_BASE, "GET", "accountSummaries?pageSize=1&pageToken=accounts-2")
    expectRequest(2, ADMIN_BASE, "GET", "properties?filter=ancestor%3Aaccounts%2F1&pageSize=1")
    expectRequest(
      3,
      ADMIN_BASE,
      "GET",
      "properties?filter=ancestor%3Aaccounts%2F1&pageSize=1&pageToken=properties-2"
    )
  })

  test("routes account, property, and nested discovery resources", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({})
    })

    const admin = (await connect()).analytics.admin
    await admin.accounts.get("accounts/1")
    await admin.accounts.getDataSharingSettings("accounts/1")
    await admin.properties.get("properties/10")
    await admin.properties.getDataRetentionSettings("properties/10")
    await admin.properties.customDimensions.list("properties/10")
    await admin.properties.customMetrics.list("properties/10")
    await admin.properties.dataStreams.list("properties/10")
    await admin.properties.dataStreams.measurementProtocolSecrets.list(
      "properties/10/dataStreams/20"
    )
    await admin.properties.firebaseLinks.list("properties/10")
    await admin.properties.googleAdsLinks.list("properties/10")
    await admin.properties.keyEvents.list("properties/10")

    const expected = [
      "accounts/1",
      "accounts/1/dataSharingSettings",
      "properties/10",
      "properties/10/dataRetentionSettings",
      "properties/10/customDimensions",
      "properties/10/customMetrics",
      "properties/10/dataStreams",
      "properties/10/dataStreams/20/measurementProtocolSecrets",
      "properties/10/firebaseLinks",
      "properties/10/googleAdsLinks",
      "properties/10/keyEvents",
    ]
    expect(requests.map((request) => request.url)).toEqual(
      expected.map((path) => `${ADMIN_BASE}${path}`)
    )
    expect(requests.every((request) => request.method === "GET")).toBe(true)
  })

  test("routes writes, field masks, archives, and read-only POST methods", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({})
    })

    const admin = (await connect()).analytics.admin
    await admin.properties.patch(
      "properties/10",
      { displayName: "Renamed" },
      { updateMask: "display_name" }
    )
    await admin.properties.customDimensions.create("properties/10", {
      parameterName: "customer_tier",
      displayName: "Customer tier",
      scope: "USER",
    })
    await admin.properties.customDimensions.archive("properties/10/customDimensions/customer_tier")
    await admin.accounts.runAccessReport("accounts/1", {
      dateRanges: [{ startDate: "2026-08-01", endDate: "2026-08-12" }],
      dimensions: [{ dimensionName: "userEmail" }],
      metrics: [{ metricName: "accessCount" }],
    })
    await admin.accounts.searchChangeHistoryEvents("accounts/1", {
      resourceType: ["PROPERTY"],
    })

    expectRequest(0, ADMIN_BASE, "PATCH", "properties/10?updateMask=display_name", {
      displayName: "Renamed",
      name: "properties/10",
    })
    expectRequest(1, ADMIN_BASE, "POST", "properties/10/customDimensions", {
      parameterName: "customer_tier",
      displayName: "Customer tier",
      scope: "USER",
    })
    expectRequest(2, ADMIN_BASE, "POST", "properties/10/customDimensions/customer_tier:archive", {})
    expectRequest(3, ADMIN_BASE, "POST", "accounts/1:runAccessReport")
    expectRequest(4, ADMIN_BASE, "POST", "accounts/1:searchChangeHistoryEvents", {
      resourceType: ["PROPERTY"],
    })
  })

  test("rejects malformed Analytics resource names before issuing a request", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({})
    })

    const properties = (await connect()).analytics.admin.properties
    expect(() => properties.get("10")).toThrow(/properties\/\{propertyId\}/)
    expect(() => properties.dataStreams.get("properties/10/notDataStreams/20")).toThrow(
      /dataStreams/
    )
    expect(requests).toHaveLength(0)
  })
})

describe("analytics.data", () => {
  test("routes every stable v1beta report method", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({})
    })

    const properties = (await connect()).analytics.data.properties
    const report = {
      property: "properties/10",
      dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
      dimensions: [{ name: "country" }],
      metrics: [{ name: "activeUsers" }],
    } as const
    await properties.runReport("properties/10", report)
    await properties.batchRunReports("properties/10", { requests: [report] })
    await properties.runPivotReport("properties/10", {
      ...report,
      pivots: [{ fieldNames: ["country"] }],
    })
    await properties.batchRunPivotReports("properties/10", {
      requests: [{ ...report, pivots: [{ fieldNames: ["country"] }] }],
    })
    await properties.runRealtimeReport("properties/10", {
      dimensions: [{ name: "country" }],
      metrics: [{ name: "activeUsers" }],
    })
    await properties.getMetadata("properties/10")
    await properties.checkCompatibility("properties/10", {
      dimensions: [{ name: "country" }],
      metrics: [{ name: "activeUsers" }],
      compatibilityFilter: "COMPATIBLE",
    })

    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["POST", `${DATA_BASE}properties/10:runReport`],
      ["POST", `${DATA_BASE}properties/10:batchRunReports`],
      ["POST", `${DATA_BASE}properties/10:runPivotReport`],
      ["POST", `${DATA_BASE}properties/10:batchRunPivotReports`],
      ["POST", `${DATA_BASE}properties/10:runRealtimeReport`],
      ["GET", `${DATA_BASE}properties/10/metadata`],
      ["POST", `${DATA_BASE}properties/10:checkCompatibility`],
    ])
    expect(requests[0]?.body).not.toHaveProperty("property")
    expect(requests[1]?.body).toEqual({ requests: [report] })
  })

  test("paginates report rows by returned row count", async () => {
    const responses = [
      { rows: [{ dimensionValues: [{ value: "FR" }] }], rowCount: 3 },
      {
        rows: [{ dimensionValues: [{ value: "CA" }] }, { dimensionValues: [{ value: "US" }] }],
        rowCount: 3,
      },
    ]
    let call = 0
    mockFetch(async (input, init) => {
      record(input, init)
      return json(responses[call++])
    })

    const rows = await collect(
      (await connect()).analytics.data.properties.runReportAll("properties/10", {
        dimensions: [{ name: "country" }],
        metrics: [{ name: "activeUsers" }],
        dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
        limit: "2",
      })
    )

    expect(rows.map((row) => row.dimensionValues?.[0]?.value)).toEqual(["FR", "CA", "US"])
    expect(requests.map((request) => request.body)).toEqual([
      expect.objectContaining({ limit: "2", offset: "0" }),
      expect.objectContaining({ limit: "2", offset: "1" }),
    ])
  })

  test("routes and paginates audience exports", async () => {
    const responses = [
      { name: "operations/1" },
      { name: "properties/10/audienceExports/20", state: "ACTIVE" },
      {
        audienceExports: [{ name: "properties/10/audienceExports/20" }],
        nextPageToken: "page-2",
      },
      { audienceExports: [{ name: "properties/10/audienceExports/21" }] },
      { audienceRows: [{ dimensionValues: [{ value: "u1" }] }], rowCount: 2 },
      { audienceRows: [{ dimensionValues: [{ value: "u2" }] }], rowCount: 2 },
    ]
    let call = 0
    mockFetch(async (input, init) => {
      record(input, init)
      return json(responses[call++])
    })

    const exports = (await connect()).analytics.data.properties.audienceExports
    await exports.create("properties/10", {
      audience: "properties/10/audiences/30",
      dimensions: [{ dimensionName: "deviceId" }],
    })
    await exports.get("properties/10/audienceExports/20")
    const listed = await collect(exports.listAll("properties/10", { pageSize: 1 }))
    const rows = await collect(exports.queryAll("properties/10/audienceExports/20", { limit: "1" }))

    expect(listed.map((item) => item.name)).toEqual([
      "properties/10/audienceExports/20",
      "properties/10/audienceExports/21",
    ])
    expect(rows.map((row) => row.dimensionValues?.[0]?.value)).toEqual(["u1", "u2"])
    expectRequest(0, DATA_BASE, "POST", "properties/10/audienceExports")
    expectRequest(1, DATA_BASE, "GET", "properties/10/audienceExports/20")
    expectRequest(2, DATA_BASE, "GET", "properties/10/audienceExports?pageSize=1")
    expectRequest(3, DATA_BASE, "GET", "properties/10/audienceExports?pageSize=1&pageToken=page-2")
    expect(requests[4]?.body).toEqual({ limit: "1", offset: "0" })
    expect(requests[5]?.body).toEqual({ limit: "1", offset: "1" })
  })

  test("validates batch and pagination limits locally", async () => {
    const properties = (await connect()).analytics.data.properties
    const request = { metrics: [{ name: "activeUsers" }] }

    expect(() =>
      properties.batchRunReports("properties/10", {
        requests: [request, request, request, request, request, request],
      })
    ).toThrow(/at most 5/)
    expect(() =>
      properties.batchRunReports("properties/10", {
        requests: [{ ...request, property: "properties/11" }],
      })
    ).toThrow(/must match/)
    await expect(
      collect(properties.runReportAll("properties/10", { ...request, limit: "250001" }))
    ).rejects.toThrow(/between 1 and 250000/)
  })

  test("retries read-only POST reports but not Admin mutations", async () => {
    let attempts = 0
    mockFetch(async (input, init) => {
      record(input, init)
      attempts++
      return attempts === 1 ? new Response("busy", { status: 503 }) : json({ rows: [] })
    })

    const client = await connect({ retry: true })
    await client.analytics.data.properties.runReport("properties/10", {
      metrics: [{ name: "activeUsers" }],
      dateRanges: [{ startDate: "yesterday", endDate: "today" }],
    })
    expect(attempts).toBe(2)

    attempts = 0
    requests = []
    mockFetch(async (input, init) => {
      record(input, init)
      attempts++
      return new Response("busy", { status: 503 })
    })
    await expect(
      client.analytics.admin.properties.create({
        parent: "accounts/1",
        displayName: "New property",
        timeZone: "Europe/Paris",
        currencyCode: "EUR",
      })
    ).rejects.toThrow(/Google API request failed/)
    expect(attempts).toBe(1)
  })
})
