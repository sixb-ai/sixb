import { describe, expect, test } from "bun:test"
import { defineObjectType, prop } from "@sixb/core"
import { createClient, createConfig } from "../src/generated/client"
import {
  type ListObjectSummariesPage,
  listObjectsInfiniteOptions,
  type TelemetryHistoryPoint,
  telemetryHistoryQueryOptions,
} from "../src/hooks"

const SocialMetricSeries = defineObjectType({
  id: "SocialMetricSeries",
  name: "Social Metric Series",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
    prop("value", "double", { mode: "telemetry" }),
  ],
})

function objectPage(count: number, hasMore: boolean): ListObjectSummariesPage {
  return {
    hasMore,
    total: 200,
    objects: Array.from({ length: count }, (_, index) => ({
      id: `Device:${index}`,
      primaryId: `device-${index}`,
      objectTypeId: "Device",
      name: `Device ${index}`,
      class: "Device",
      properties: {},
      telemetry: {},
      actions: {},
      telemetryCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
  }
}

describe("listObjectsInfiniteOptions", () => {
  test("keeps the initial offset when calculating the next page", () => {
    const options = listObjectsInfiniteOptions({
      query: {
        limit: "50",
        offset: "100",
      },
    })

    expect(options.initialPageParam).toBe("100")
    expect(
      options.getNextPageParam?.(objectPage(50, true), [objectPage(50, true)], "100", ["100"])
    ).toBe("150")
  })

  test("stops pagination when the current page has no more results", () => {
    const options = listObjectsInfiniteOptions({
      query: {
        limit: "50",
        offset: "100",
      },
    })

    expect(
      options.getNextPageParam?.(objectPage(20, false), [objectPage(20, false)], "100", ["100"])
    ).toBeUndefined()
  })
})

function createTelemetryTestClient() {
  const requests: Request[] = []
  const client = createClient(
    createConfig({
      baseUrl: "http://sixb.test",
      fetch: (async (request: Request) => {
        requests.push(request)
        return Response.json([
          {
            projectId: "default",
            objectTypeId: "SocialMetricSeries",
            objectId: "engagement-series",
            propertyId: "value",
            value: 42.5,
            unit: "count",
            at: "2026-01-02T00:00:00.000Z",
          },
        ])
      }) as unknown as typeof fetch,
    })
  )

  return { client, requests }
}

describe("telemetryHistoryQueryOptions", () => {
  test("maps ontology tokens to the telemetry history route", async () => {
    const { client, requests } = createTelemetryTestClient()
    const options = telemetryHistoryQueryOptions({
      client,
      objectType: SocialMetricSeries,
      objectId: "engagement-series",
      property: SocialMetricSeries.p.value,
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: "2026-01-03T00:00:00.000Z",
      limit: 25,
    })

    expect(options.queryKey as unknown).toEqual([
      "sixb",
      "telemetry",
      "history",
      {
        objectTypeId: "SocialMetricSeries",
        objectId: "engagement-series",
        propertyId: "value",
      },
      {
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-03T00:00:00.000Z",
        limit: "25",
        order: "asc",
      },
    ])

    const queryFn = options.queryFn as unknown as (context: {
      signal?: AbortSignal
    }) => Promise<readonly TelemetryHistoryPoint<number>[]>
    const history = await queryFn({})

    const requestUrl = new URL(requests[0]?.url ?? "")
    expect(requestUrl.pathname).toBe(
      "/api/objects/SocialMetricSeries/engagement-series/telemetry/value/history"
    )
    expect(requestUrl.searchParams.get("from")).toBe("2026-01-01T00:00:00.000Z")
    expect(requestUrl.searchParams.get("to")).toBe("2026-01-03T00:00:00.000Z")
    expect(requestUrl.searchParams.get("limit")).toBe("25")
    expect(requestUrl.searchParams.get("order")).toBe("asc")
    expect(history[0]?.value).toBe(42.5)
    expect(history[0]?.at).toBe("2026-01-02T00:00:00.000Z")
  })
})
