import { afterEach, describe, expect, test } from "bun:test"
import { defineObjectType, prop } from "@sixb/core"
import { createClient, createConfig } from "../src/generated/client"
import { client as defaultClient } from "../src/generated/client.gen"
import {
  type BulkTelemetryHistory,
  bulkTelemetryHistoryQueryOptions,
  type ListObjectSummariesPage,
  listObjectsInfiniteOptions,
  listRelationshipsOptions,
  type TelemetryHistoryPoint,
  telemetryHistoryQueryOptions,
} from "../src/hooks"
import { encodeObjectId } from "../src/models"

afterEach(() => {
  defaultClient.setConfig({ baseUrl: undefined, fetch: undefined })
})

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

describe("listRelationshipsOptions", () => {
  test("queries opaque object refs in the request body and follows link pages", async () => {
    const requests: Request[] = []
    const bodies: Array<Record<string, unknown>> = []
    defaultClient.setConfig({
      baseUrl: "http://sixb.test",
      fetch: (async (request: Request) => {
        requests.push(request)
        const body = (await request.json()) as Record<string, unknown>
        bodies.push(body)
        const secondPage = body.pageToken === "page-2"
        return Response.json({
          objects: [],
          links: [
            {
              source: {
                objectTypeId: secondPage ? "RepositoryComment" : "RepositoryIssue",
                primaryId: secondPage ? "comment-1" : "github:issue:sixb-ai/sixb#297",
              },
              linkId: secondPage ? "issue" : "repository",
              target: {
                objectTypeId: secondPage ? "RepositoryIssue" : "Repository",
                primaryId: secondPage ? "github:issue:sixb-ai/sixb#297" : "sixb-ai/sixb",
              },
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          hasMore: !secondPage,
          ...(secondPage ? {} : { nextPageToken: "page-2" }),
        })
      }) as unknown as typeof fetch,
    })

    const options = listRelationshipsOptions({
      query: {
        objectId: encodeObjectId("RepositoryIssue", "github:issue:sixb-ai/sixb#297"),
      },
    })
    const queryFn = options.queryFn as unknown as () => Promise<
      Array<{ source: string; target: string; type: string }>
    >
    const relationships = await queryFn()

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/objects/query/links",
      "/api/objects/query/links",
    ])
    expect(bodies[0]).toEqual({
      query: {
        kind: "refs",
        refs: [
          {
            objectTypeId: "RepositoryIssue",
            primaryId: "github:issue:sixb-ai/sixb#297",
          },
        ],
      },
      direction: "both",
      pageSize: 1_000,
    })
    expect(bodies[1]).toMatchObject({ pageToken: "page-2" })
    expect(relationships).toHaveLength(2)
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

function createBulkTelemetryTestClient() {
  const requests: Request[] = []
  const bodies: unknown[] = []
  const client = createClient(
    createConfig({
      baseUrl: "http://sixb.test",
      fetch: (async (request: Request) => {
        requests.push(request)
        bodies.push(await request.json())
        return Response.json({
          series: [
            {
              objectTypeId: "SocialMetricSeries",
              objectId: "engagement-series",
              propertyId: "value",
              points: [
                {
                  projectId: "default",
                  objectTypeId: "SocialMetricSeries",
                  objectId: "engagement-series",
                  propertyId: "value",
                  value: 42.5,
                  unit: "count",
                  at: "2026-01-02T00:00:00.000Z",
                },
              ],
            },
            {
              objectTypeId: "SocialMetricSeries",
              objectId: "missing-series",
              propertyId: "value",
              points: [],
            },
          ],
        })
      }) as unknown as typeof fetch,
    })
  )

  return { client, requests, bodies }
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

describe("bulkTelemetryHistoryQueryOptions", () => {
  test("maps ontology tokens to the bulk telemetry history route", async () => {
    const { client, requests, bodies } = createBulkTelemetryTestClient()
    const options = bulkTelemetryHistoryQueryOptions({
      client,
      objectType: SocialMetricSeries,
      objectIds: ["engagement-series", "missing-series"],
      properties: [SocialMetricSeries.p.value] as const,
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: "2026-01-03T00:00:00.000Z",
      limit: 25,
    })

    expect(options.queryKey as unknown).toEqual([
      "sixb",
      "telemetry",
      "history",
      "bulk",
      {
        series: [
          {
            objectTypeId: "SocialMetricSeries",
            objectId: "engagement-series",
            propertyId: "value",
          },
          {
            objectTypeId: "SocialMetricSeries",
            objectId: "missing-series",
            propertyId: "value",
          },
        ],
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-03T00:00:00.000Z",
        limitPerSeries: 25,
        order: "asc",
      },
    ])

    const queryFn = options.queryFn as unknown as (context: {
      signal?: AbortSignal
    }) => Promise<BulkTelemetryHistory<readonly [typeof SocialMetricSeries.p.value]>>
    const history = await queryFn({})

    const requestUrl = new URL(requests[0]?.url ?? "")
    expect(requestUrl.pathname).toBe("/api/telemetry/history")
    expect(bodies[0]).toEqual({
      series: [
        {
          objectTypeId: "SocialMetricSeries",
          objectId: "engagement-series",
          propertyId: "value",
        },
        {
          objectTypeId: "SocialMetricSeries",
          objectId: "missing-series",
          propertyId: "value",
        },
      ],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-03T00:00:00.000Z",
      limitPerSeries: 25,
      order: "asc",
    })
    expect(history[0]?.points[0]?.value).toBe(42.5)
    expect(history[1]?.points).toEqual([])
  })
})
