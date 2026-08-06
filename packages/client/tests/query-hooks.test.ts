import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { defineObjectType, prop, stringEnum } from "@sixb/core"
import { QueryClient } from "@tanstack/react-query"
import { type ActionRunDetail, ActionRunFailedError } from "../src/actions"
import {
  getObjectQueryKey as generatedGetObjectQueryKey,
  getActionRunQueryKey,
  listActionRunsInfiniteQueryKey,
  listActionRunsQueryKey,
} from "../src/generated/@tanstack/react-query.gen"
import { createClient, createConfig } from "../src/generated/client"
import { objects } from "../src/query"
import {
  type ActionRunMutationRequest,
  actionRunMutationOptions,
  invalidateObjectCountQuery,
  invalidateObjectExistsQuery,
  invalidateObjectFacetsQuery,
  invalidateObjectInfiniteQuery,
  invalidateObjectQueries,
  invalidateObjectQuery,
  objectQueryCountOptions,
  objectQueryExistsOptions,
  objectQueryFacetsOptions,
  objectQueryInfiniteOptions,
  objectQueryKeys,
  objectQueryOptions,
} from "../src/query-hooks"

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.onclose?.()
  }
}

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

function createActionRun(overrides: Partial<ActionRunDetail> = {}): ActionRunDetail {
  return {
    id: "act_1",
    projectId: "proj",
    actionId: "approveQuote",
    subject: { kind: "object", objectTypeId: "Project", primaryId: "p_1" },
    status: "queued",
    queuedAt: "2026-06-29T12:00:00.000Z",
    params: {},
    ...overrides,
  }
}

function createActionTestClient() {
  const requests: { method: string; path: string; body?: unknown }[] = []
  const succeeded = createActionRun({
    status: "succeeded",
    finishedAt: "2026-06-29T12:00:02.000Z",
  })
  const client = createClient(
    createConfig({
      baseUrl: "http://sixb.test",
      fetch: (async (request: Request) => {
        const url = new URL(request.url)
        const body = request.method === "POST" ? await request.json() : undefined
        requests.push({ method: request.method, path: url.pathname, body })
        if (request.method === "POST" && url.pathname.startsWith("/api/actions/")) {
          return Response.json(
            { runId: "act_1", queuedAt: "2026-06-29T12:00:00.000Z", created: true },
            { status: 202 }
          )
        }
        if (request.method === "GET" && url.pathname === "/api/action-runs/act_1") {
          return Response.json(succeeded)
        }
        return Response.json({ error: "Unexpected request" }, { status: 500 })
      }) as unknown as typeof fetch,
    })
  )
  return { client, requests, succeeded }
}

let originalWebSocket: typeof WebSocket

beforeEach(() => {
  originalWebSocket = globalThis.WebSocket
  FakeWebSocket.instances = []
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
})

afterEach(() => {
  globalThis.WebSocket = originalWebSocket
})

describe("objectQueryOptions", () => {
  test("objectQueryKeys match the option factory query keys", () => {
    const query = activeProjects().limit(10)
    const facets = [{ property: Project.p.status, limit: 10 }] as const
    const pageOptions = { pageSize: 50 }

    expect(objectQueryKeys.all()).toEqual(["sixb", "objects"])
    expect(objectQueryKeys.list(query)).toEqual(objectQueryOptions(query).queryKey)
    expect(objectQueryKeys.list(query, { includeTotal: false })).toEqual(
      objectQueryOptions(query, { includeTotal: false }).queryKey
    )
    expect(objectQueryKeys.count(query)).toEqual(objectQueryCountOptions(query).queryKey)
    expect(objectQueryKeys.exists(query)).toEqual(objectQueryExistsOptions(query).queryKey)
    expect(objectQueryKeys.facets(query, facets)).toEqual(
      objectQueryFacetsOptions(query, facets).queryKey
    )
    expect(objectQueryKeys.infinite(query, pageOptions)).toEqual(
      objectQueryInfiniteOptions(query, pageOptions).queryKey
    )
  })

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

describe("object query invalidation helpers", () => {
  test("invalidates the exact list query key", async () => {
    const queryClient = new QueryClient()
    const query = activeProjects()
    const listKey = objectQueryKeys.list(query)
    const countKey = objectQueryKeys.count(query)

    queryClient.setQueryData(listKey, ["list"])
    queryClient.setQueryData(countKey, 1)

    await invalidateObjectQuery(queryClient, query)

    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(countKey)?.isInvalidated).toBe(false)
    queryClient.clear()
  })

  test("invalidates exact count, exists, facet, and infinite query keys", async () => {
    const queryClient = new QueryClient()
    const query = activeProjects()
    const facets = [{ property: Project.p.status, limit: 10 }] as const
    const countKey = objectQueryKeys.count(query)
    const existsKey = objectQueryKeys.exists(query)
    const facetsKey = objectQueryKeys.facets(query, facets)
    const infiniteKey = objectQueryKeys.infinite(query, { pageSize: 50 })

    queryClient.setQueryData(countKey, 1)
    queryClient.setQueryData(existsKey, true)
    queryClient.setQueryData(facetsKey, [])
    queryClient.setQueryData(infiniteKey, { pages: [], pageParams: [] })

    await invalidateObjectCountQuery(queryClient, query)
    await invalidateObjectExistsQuery(queryClient, query)
    await invalidateObjectFacetsQuery(queryClient, query, facets)
    await invalidateObjectInfiniteQuery(queryClient, query, { pageSize: 50 })

    expect(queryClient.getQueryState(countKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(existsKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(facetsKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(infiniteKey)?.isInvalidated).toBe(true)
    queryClient.clear()
  })

  test("can invalidate the whole typed object query cache group", async () => {
    const queryClient = new QueryClient()
    const query = activeProjects()
    const listKey = objectQueryKeys.list(query)
    const existsKey = objectQueryKeys.exists(query)

    queryClient.setQueryData(listKey, ["list"])
    queryClient.setQueryData(existsKey, true)

    await invalidateObjectQueries(queryClient)

    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(existsKey)?.isInvalidated).toBe(true)
    queryClient.clear()
  })
})

describe("actionRunMutationOptions", () => {
  test("configured mutations treat variables as action params and wait for the terminal run", async () => {
    const { client, requests, succeeded } = createActionTestClient()
    const options = actionRunMutationOptions<{ note: string }>({
      client,
      actionId: "approveQuote",
      subject: { objectType: Project, primaryId: "p_1" },
      timeoutMs: 500,
    })

    const mutationFn = options.mutationFn as (params: { note: string }) => Promise<ActionRunDetail>
    const run = await mutationFn({ note: "Approved" })

    expect(run).toEqual(succeeded)
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/actions/approveQuote",
        body: {
          subject: { kind: "object", objectTypeId: "Project", primaryId: "p_1" },
          params: { note: "Approved" },
        },
      },
      { method: "GET", path: "/api/action-runs/act_1", body: undefined },
    ])
    expect(FakeWebSocket.instances[0]?.closed).toBe(true)
  })

  test("configured mutations still accept the generated object subject shape", async () => {
    const { client, requests, succeeded } = createActionTestClient()
    const options = actionRunMutationOptions<{ note: string }>({
      client,
      actionId: "approveQuote",
      subject: { kind: "object", objectTypeId: "Project", primaryId: "p_1" },
      timeoutMs: 500,
    })

    const mutationFn = options.mutationFn as (params: { note: string }) => Promise<ActionRunDetail>
    const run = await mutationFn({ note: "Approved" })

    expect(run).toEqual(succeeded)
    expect(requests[0]).toEqual({
      method: "POST",
      path: "/api/actions/approveQuote",
      body: {
        subject: { kind: "object", objectTypeId: "Project", primaryId: "p_1" },
        params: { note: "Approved" },
      },
    })
  })

  test("dynamic mutations accept the full generated request shape", async () => {
    const { client, requests, succeeded } = createActionTestClient()
    const options = actionRunMutationOptions({ client, timeoutMs: 500 })

    const mutationFn = options.mutationFn as (
      request: ActionRunMutationRequest
    ) => Promise<ActionRunDetail>
    const run = await mutationFn({
      path: { actionId: "approveQuote" },
      body: {
        subject: { kind: "object", objectTypeId: "Project", primaryId: "p_1" },
        params: { note: "Approved" },
      },
    })

    expect(run).toEqual(succeeded)
    expect(requests[0]).toEqual({
      method: "POST",
      path: "/api/actions/approveQuote",
      body: {
        subject: { kind: "object", objectTypeId: "Project", primaryId: "p_1" },
        params: { note: "Approved" },
      },
    })
  })

  test("dynamic mutations accept ontology object subjects", async () => {
    const { client, requests, succeeded } = createActionTestClient()
    const options = actionRunMutationOptions({ client, timeoutMs: 500 })

    const mutationFn = options.mutationFn as (
      request: ActionRunMutationRequest
    ) => Promise<ActionRunDetail>
    const run = await mutationFn({
      path: { actionId: "approveQuote" },
      body: {
        subject: { objectType: Project, primaryId: "p_1" },
        params: { note: "Approved" },
      },
    })

    expect(run).toEqual(succeeded)
    expect(requests[0]).toEqual({
      method: "POST",
      path: "/api/actions/approveQuote",
      body: {
        subject: { kind: "object", objectTypeId: "Project", primaryId: "p_1" },
        params: { note: "Approved" },
      },
    })
  })

  test("invalidateOnCommit invalidates action run and object query caches", async () => {
    const queryClient = new QueryClient()
    const query = activeProjects()
    const run = createActionRun({
      status: "succeeded",
      phase: "effects",
      finishedAt: "2026-06-29T12:00:02.000Z",
    })
    const actionRunKey = getActionRunQueryKey({ path: { runId: "act_1" } })
    const actionRunsKey = listActionRunsQueryKey()
    const actionRunsInfiniteKey = listActionRunsInfiniteQueryKey()
    const objectQueryKey = objectQueryKeys.list(query)
    const generatedObjectKey = generatedGetObjectQueryKey({
      path: { objectTypeId: "Project", objectId: "p_1" },
    })
    let userOnSuccessCalled = false

    queryClient.setQueryData(actionRunKey, run)
    queryClient.setQueryData(actionRunsKey, { runs: [], hasMore: false, total: 0 })
    queryClient.setQueryData(actionRunsInfiniteKey, { pages: [], pageParams: [] })
    queryClient.setQueryData(objectQueryKey, ["projects"])
    queryClient.setQueryData(generatedObjectKey, { primaryId: "p_1" })

    const options = actionRunMutationOptions<{ note: string }>({
      actionId: "approveQuote",
      queryClient,
      invalidateOnCommit: true,
      onSuccess: () => {
        userOnSuccessCalled = true
      },
    })
    const onSuccess = options.onSuccess as (
      data: ActionRunDetail,
      variables: { note: string },
      context: unknown
    ) => Promise<void>

    await onSuccess(run, { note: "Approved" }, undefined)

    expect(queryClient.getQueryState(actionRunKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(actionRunsKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(actionRunsInfiniteKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(objectQueryKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(generatedObjectKey)?.isInvalidated).toBe(true)
    expect(userOnSuccessCalled).toBe(true)
    queryClient.clear()
  })

  test("terminal failure errors invalidate action run caches without object commit invalidation", async () => {
    const queryClient = new QueryClient()
    const query = activeProjects()
    const failed = createActionRun({
      status: "failed",
      finishedAt: "2026-06-29T12:00:02.000Z",
      error: {
        code: "internal.unexpected",
        message: "Writeback failed",
        retryable: false,
        at: "2026-06-29T12:00:02.000Z",
        phase: "writeback",
      },
    })
    const actionRunKey = getActionRunQueryKey({ path: { runId: "act_1" } })
    const actionRunsKey = listActionRunsQueryKey()
    const objectQueryKey = objectQueryKeys.list(query)
    let userOnErrorCalled = false

    queryClient.setQueryData(actionRunKey, failed)
    queryClient.setQueryData(actionRunsKey, { runs: [], hasMore: false, total: 0 })
    queryClient.setQueryData(objectQueryKey, ["projects"])

    const options = actionRunMutationOptions<{ note: string }>({
      actionId: "approveQuote",
      queryClient,
      invalidateOnCommit: true,
      onError: () => {
        userOnErrorCalled = true
      },
    })
    const onError = options.onError as (
      error: Error,
      variables: { note: string },
      context: unknown
    ) => Promise<void>

    await onError(
      new ActionRunFailedError(failed as ActionRunDetail & { readonly status: "failed" }),
      { note: "Approved" },
      undefined
    )

    expect(queryClient.getQueryState(actionRunKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(actionRunsKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(objectQueryKey)?.isInvalidated).toBe(false)
    expect(userOnErrorCalled).toBe(true)
    queryClient.clear()
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
