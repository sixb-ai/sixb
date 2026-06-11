import { describe, expect, test } from "bun:test"
import { defineObjectType, link, prop, stringEnum } from "@sixb/core"
import { createClient, createConfig } from "../src/generated/client"
import { objects, SixbQueryError } from "../src/query"

const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { query: { searchable: true, text: true, sortable: true } }),
  ],
})

const Project = defineObjectType({
  id: "Project",
  name: "Project",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { query: { searchable: true, text: true, sortable: true } }),
    prop("status", stringEnum(["draft", "active", "paused"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("budget", "double", { query: { searchable: true, filterable: true, sortable: true } }),
  ],
  links: [link("customer", Customer, { cardinality: "one" })],
})

type RecordedCall = { url: string; body: unknown }

function createTestClient(respond: (call: RecordedCall) => Response) {
  const calls: RecordedCall[] = []
  const client = createClient(
    createConfig({
      baseUrl: "http://sixb.test",
      fetch: (async (request: Request) => {
        const call = { url: new URL(request.url).pathname, body: await request.json() }
        calls.push(call)
        return respond(call)
      }) as unknown as typeof fetch,
    })
  )
  return { client, calls }
}

const emptyPlan = {
  mode: "pushdown",
  providerIssues: [],
  fallbackIssues: [],
  issues: [],
}

const row = {
  primaryId: "proj-001",
  objectTypeId: "Project",
  properties: { id: "proj-001", name: "Dashboard", status: "active", budget: 50_000 },
  createdAt: "2026-01-02T03:04:05.000Z",
  updatedAt: "2026-02-03T04:05:06.000Z",
}

describe("objects().query()", () => {
  test("list() posts the normalized IR and revives row dates", async () => {
    const { client, calls } = createTestClient(() =>
      Response.json({ objects: [row], hasMore: false, total: 1, plan: emptyPlan })
    )

    const result = await objects(Project, { client })
      .query()
      .where((project) => project.and(project.p.status.eq("active"), project.p.budget.gte(10_000)))
      .orderBy(Project.p.budget, "desc")
      .limit(20)
      .list()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("/api/objects/query")
    expect(calls[0]?.body).toEqual({
      query: {
        kind: "limit",
        limit: 20,
        input: {
          kind: "sort",
          fields: [{ kind: "property", propertyId: "budget", direction: "desc" }],
          input: {
            kind: "filter",
            predicate: {
              op: "and",
              items: [
                { op: "eq", propertyId: "status", value: "active" },
                { op: "gte", propertyId: "budget", value: 10_000 },
              ],
            },
            input: { kind: "start", objectTypeId: "Project" },
          },
        },
      },
    })

    expect(result.total).toBe(1)
    expect(result.hasMore).toBe(false)
    expect(result.objects[0]?.properties.name).toBe("Dashboard")
    expect(result.objects[0]?.createdAt).toEqual(new Date("2026-01-02T03:04:05.000Z"))
    expect(result.objects[0]?.updatedAt).toEqual(new Date("2026-02-03T04:05:06.000Z"))
  })

  test("list({ includeTotal: false }) forwards the flag and omits total", async () => {
    const { client, calls } = createTestClient(() =>
      Response.json({ objects: [], hasMore: true, nextPageToken: "next", plan: emptyPlan })
    )

    const page = await objects(Project, { client })
      .query()
      .page({ pageSize: 25 })
      .list({ includeTotal: false })

    expect(calls[0]?.body).toEqual({
      query: { kind: "page", pageSize: 25, input: { kind: "start", objectTypeId: "Project" } },
      includeTotal: false,
    })
    expect(page.total).toBeUndefined()
    expect(page.nextPageToken).toBe("next")
  })

  test("first() wraps the query with limit 1", async () => {
    const { client, calls } = createTestClient(() =>
      Response.json({ objects: [row], hasMore: false, total: 1, plan: emptyPlan })
    )

    const first = await objects(Project, { client })
      .query()
      .where((project) => project.p.id.eq("proj-001"))
      .first()

    expect(calls[0]?.body).toEqual({
      query: {
        kind: "limit",
        limit: 1,
        input: {
          kind: "filter",
          predicate: { op: "eq", propertyId: "id", value: "proj-001" },
          input: { kind: "start", objectTypeId: "Project" },
        },
      },
    })
    expect(first?.primaryId).toBe("proj-001")
  })

  test("count() and exists() hit their routes", async () => {
    const { client, calls } = createTestClient((call) =>
      call.url.endsWith("/count")
        ? Response.json({ count: 7, plan: emptyPlan })
        : Response.json({ exists: true, plan: emptyPlan })
    )

    const query = objects(Project, { client })
      .query()
      .where((project) => project.p.status.eq("active"))

    expect(await query.count()).toBe(7)
    expect(await query.exists()).toBe(true)
    expect(calls.map((call) => call.url)).toEqual([
      "/api/objects/query/count",
      "/api/objects/query/exists",
    ])
  })

  test("facets() posts facet requests and returns buckets", async () => {
    const { client, calls } = createTestClient(() =>
      Response.json({
        facets: [
          {
            propertyId: "status",
            buckets: [
              { value: "active", count: 12 },
              { value: "paused", count: 3 },
            ],
          },
        ],
        plan: emptyPlan,
      })
    )

    const facets = await objects(Project, { client })
      .query()
      .facets([{ property: Project.p.status, limit: 10 }])

    expect(calls[0]?.url).toBe("/api/objects/query/facets")
    expect(calls[0]?.body).toEqual({
      query: { kind: "start", objectTypeId: "Project" },
      facets: [{ propertyId: "status", limit: 10 }],
    })
    expect(facets[0]?.buckets).toEqual([
      { value: "active", count: 12 },
      { value: "paused", count: 3 },
    ])
  })

  test("traverse() emits the traverse node and where() keeps working after it", async () => {
    const { client, calls } = createTestClient(() =>
      Response.json({ objects: [], hasMore: false, total: 0, plan: emptyPlan })
    )

    await objects(Customer, { client })
      .query()
      .where((customer) => customer.p.id.eq("cust-001"))
      .traverse(Project.l.customer, { direction: "incoming" })
      .where((project) => project.p.status.eq("active"))
      .list()

    expect(calls[0]?.body).toEqual({
      query: {
        kind: "filter",
        predicate: { op: "eq", propertyId: "status", value: "active" },
        input: {
          kind: "traverse",
          linkId: "customer",
          direction: "incoming",
          sourceObjectTypeId: "Project",
          input: {
            kind: "filter",
            predicate: { op: "eq", propertyId: "id", value: "cust-001" },
            input: { kind: "start", objectTypeId: "Customer" },
          },
        },
      },
    })
  })

  test("query errors surface as SixbQueryError with server issues", async () => {
    const { client } = createTestClient(
      () =>
        new Response(
          JSON.stringify({
            error: "Object query validation failed",
            issues: [{ path: "$.predicate", code: "unknown_property", message: "Unknown" }],
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
    )

    const promise = objects(Project, { client })
      .query()
      .where((project) => project.p.status.eq("active"))
      .list()

    expect(promise).rejects.toThrow(SixbQueryError)
    expect(promise).rejects.toThrow("Object query validation failed")
    await promise.catch((error: SixbQueryError) => {
      expect(error.issues).toEqual([
        { path: "$.predicate", code: "unknown_property", message: "Unknown" },
      ])
    })
  })

  test("works against a client configured with responseStyle data and throwOnError", async () => {
    const calls: RecordedCall[] = []
    const client = createClient(
      createConfig({
        baseUrl: "http://sixb.test",
        responseStyle: "data",
        throwOnError: true,
        fetch: (async (request: Request) => {
          const call = { url: new URL(request.url).pathname, body: await request.json() }
          calls.push(call)
          return calls.length === 1
            ? Response.json({ objects: [row], hasMore: false, total: 1, plan: emptyPlan })
            : new Response(JSON.stringify({ error: "Invalid object query", issues: [] }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
              })
        }) as unknown as typeof fetch,
      })
    )

    const result = await objects(Project, { client }).query().limit(1).list()
    expect(result.total).toBe(1)

    const failing = objects(Project, { client }).query().limit(1).list()
    expect(failing).rejects.toThrow(SixbQueryError)
    await failing.catch(() => {})
  })

  test("validate() is server-side only", () => {
    const { client } = createTestClient(() => Response.json({}))
    const query = objects(Project, { client }).query()

    expect(() => query.validate()).toThrow("requires ontology access")
  })
})
