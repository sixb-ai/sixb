import { describe, expect, test } from "bun:test"
import { defineObjectType, prop, stringEnum } from "@sixb/core"
import { createClient, createConfig } from "../src/generated/client"
import { objects } from "../src/query"
import {
  objectQueryCountOptions,
  objectQueryInfiniteOptions,
  objectQueryOptions,
} from "../src/query-hooks"

const Project = defineObjectType({
  id: "Project",
  name: "Project",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", stringEnum(["draft", "active"]), {
      query: { searchable: true, filterable: true, exact: true },
    }),
  ],
})

function createTestClient(respond: (body: unknown) => Response) {
  const bodies: unknown[] = []
  const client = createClient(
    createConfig({
      baseUrl: "http://sixb.test",
      fetch: (async (request: Request) => {
        const body = await request.json()
        bodies.push(body)
        return respond(body)
      }) as unknown as typeof fetch,
    })
  )
  return { client, bodies }
}

function activeProjects(client?: ReturnType<typeof createTestClient>["client"]) {
  return objects(Project, { client })
    .query()
    .where((project) => project.p.status.eq("active"))
}

describe("objectQueryOptions", () => {
  test("query keys are stable across separately built identical queries", () => {
    const first = objectQueryOptions(activeProjects().limit(10))
    const second = objectQueryOptions(activeProjects().limit(10))
    const different = objectQueryOptions(activeProjects().limit(20))

    expect(first.queryKey).toEqual(second.queryKey)
    expect(JSON.stringify(first.queryKey)).toBe(JSON.stringify(second.queryKey))
    expect(first.queryKey).not.toEqual(different.queryKey)
  })

  test("count keys do not collide with list keys for the same IR", () => {
    const query = activeProjects()
    expect(objectQueryOptions(query).queryKey).not.toEqual(objectQueryCountOptions(query).queryKey)
  })

  test("forwards includeTotal to the request and keys it separately", async () => {
    const { client, bodies } = createTestClient(() =>
      Response.json({
        objects: [],
        hasMore: false,
        plan: { mode: "pushdown", providerIssues: [], fallbackIssues: [], issues: [] },
      })
    )

    const withTotal = objectQueryOptions(activeProjects(client))
    const withoutTotal = objectQueryOptions(activeProjects(client), { includeTotal: false })
    expect(withTotal.queryKey).not.toEqual(withoutTotal.queryKey)

    const queryFn = withoutTotal.queryFn as unknown as () => Promise<{ total?: undefined }>
    const page = await queryFn()

    expect(bodies[0]).toMatchObject({ includeTotal: false })
    expect(page.total).toBeUndefined()
  })
})

describe("objectQueryInfiniteOptions", () => {
  test("threads the page token through each fetch and stops when absent", async () => {
    const { client, bodies } = createTestClient(() =>
      Response.json({
        objects: [],
        hasMore: true,
        nextPageToken: "token-2",
        plan: { mode: "pushdown", providerIssues: [], fallbackIssues: [], issues: [] },
      })
    )

    const options = objectQueryInfiniteOptions(activeProjects(client), { pageSize: 50 })
    expect(options.initialPageParam).toBeUndefined()

    const queryFn = options.queryFn as unknown as (context: { pageParam?: string }) => Promise<{
      hasMore: boolean
      nextPageToken?: string
    }>

    const firstPage = await queryFn({ pageParam: undefined })
    const secondPage = await queryFn({ pageParam: firstPage.nextPageToken })

    const pageNodes = bodies.map(
      (body) => (body as { query: { kind: string; pageSize: number; pageToken?: string } }).query
    )
    expect(pageNodes[0]).toMatchObject({ kind: "page", pageSize: 50 })
    expect(pageNodes[0]?.pageToken).toBeUndefined()
    expect(pageNodes[1]).toMatchObject({ kind: "page", pageSize: 50, pageToken: "token-2" })

    expect(bodies[0]).toMatchObject({ includeTotal: false })
    expect(options.getNextPageParam(secondPage as never, [] as never, undefined, [])).toBe(
      "token-2"
    )
    expect(
      options.getNextPageParam({ hasMore: false } as never, [] as never, undefined, [])
    ).toBeUndefined()
  })
})
