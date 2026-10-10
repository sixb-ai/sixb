import { describe, expect, test } from "bun:test"
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
    status: "succeeded",
    phase: "commit",
    startedAt: "2026-06-29T12:00:00.000Z",
    finishedAt: "2026-06-29T12:00:02.000Z",
    params: {},
    ...overrides,
  }
}

function actionFailure(
  message: string,
  phase: "writeback" | "commit" = "writeback"
): NonNullable<ActionRunDetail["error"]> {
  return {
    code: "action.phase_failed",
    message,
    retryable: false,
    at: "2026-06-29T12:00:02.000Z",
    details: { actionId: "approveQuote", runId: "act_1", phase },
  }
}

/** A client whose API answers every action request with `respond()`, recording each request. */
function createActionTestClient(respond: () => Response = () => Response.json(createActionRun())) {
  const requests: { method: string; path: string; body?: unknown }[] = []
  const client = createClient(
    createConfig({
      baseUrl: "http://sixb.test",
      fetch: (async (request: Request) => {
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body: await request.json(),
        })
        return respond()
      }) as unknown as typeof fetch,
    })
  )
  return { client, requests }
}

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
  const expectedRequest = {
    method: "POST",
    path: "/api/actions/approveQuote",
    body: {
      subject: { kind: "object", objectTypeId: "Project", primaryId: "p_1" },
      params: { note: "Approved" },
    },
  }

  test("configured mutations send variables as action params and resolve with the run", async () => {
    const { client, requests } = createActionTestClient()
    const options = actionRunMutationOptions<{ note: string }>({
      client,
      actionId: "approveQuote",
      subject: { objectType: Project, primaryId: "p_1" },
    })

    const mutationFn = options.mutationFn as (params: { note: string }) => Promise<ActionRunDetail>
    const run = await mutationFn({ note: "Approved" })

    expect(run).toEqual(createActionRun())
    expect(requests).toEqual([expectedRequest])
  })

  test("configured mutations still accept the generated object subject shape", async () => {
    const { client, requests } = createActionTestClient()
    const options = actionRunMutationOptions<{ note: string }>({
      client,
      actionId: "approveQuote",
      subject: { kind: "object", objectTypeId: "Project", primaryId: "p_1" },
    })

    const mutationFn = options.mutationFn as (params: { note: string }) => Promise<ActionRunDetail>
    await mutationFn({ note: "Approved" })

    expect(requests).toEqual([expectedRequest])
  })

  test("dynamic mutations accept the full generated request shape", async () => {
    const { client, requests } = createActionTestClient()
    const options = actionRunMutationOptions({ client })

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

    expect(run).toEqual(createActionRun())
    expect(requests).toEqual([expectedRequest])
  })

  test("dynamic mutations accept ontology object subjects", async () => {
    const { client, requests } = createActionTestClient()
    const options = actionRunMutationOptions({ client })

    const mutationFn = options.mutationFn as (
      request: ActionRunMutationRequest
    ) => Promise<ActionRunDetail>
    await mutationFn({
      path: { actionId: "approveQuote" },
      body: {
        subject: { objectType: Project, primaryId: "p_1" },
        params: { note: "Approved" },
      },
    })

    expect(requests).toEqual([expectedRequest])
  })

  test("rejects with ActionRunFailedError when the run failed", async () => {
    const finished = createActionRun({
      status: "failed",
      phase: "writeback",
      error: actionFailure("Writeback failed"),
    })
    const { client } = createActionTestClient(() => Response.json(finished))
    const options = actionRunMutationOptions<{ note: string }>({
      client,
      actionId: "approveQuote",
    })

    const mutationFn = options.mutationFn as (params: { note: string }) => Promise<ActionRunDetail>
    const error = await mutationFn({ note: "Approved" }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ActionRunFailedError)
    expect(error).toMatchObject({ status: "failed", message: "Writeback failed", run: finished })
  })

  test("rejects with the API error when the request did not become a run", async () => {
    const inProgress = {
      error: "Action run 'act_1' is already in progress.",
      code: "action.run_in_progress",
    }
    const { client } = createActionTestClient(() => Response.json(inProgress, { status: 409 }))
    const options = actionRunMutationOptions<{ note: string }>({
      client,
      actionId: "approveQuote",
      runId: "act_1",
    })

    const mutationFn = options.mutationFn as (params: { note: string }) => Promise<ActionRunDetail>

    await expect(mutationFn({ note: "Approved" })).rejects.toEqual(inProgress)
  })

  test("invalidateOnCommit invalidates action run and object query caches", async () => {
    const queryClient = new QueryClient()
    const query = activeProjects()
    // A run with edits is returned in its commit phase: its effects run after the response.
    const run = createActionRun({ phase: "commit" })
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

  // Guard proof: drop the status check from `invalidateActionRunMutationCaches`
  // (`src/query-hooks.ts`), and the run that failed in its commit phase invalidates object reads.
  test("terminal failure errors invalidate action run caches without object commit invalidation", async () => {
    const queryClient = new QueryClient()
    const query = activeProjects()
    // A run that fails in its commit phase committed nothing: its record and edits land together.
    const failed = {
      ...createActionRun({ phase: "commit", error: actionFailure("Commit failed", "commit") }),
      status: "failed" as const,
    }
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

    await onError(new ActionRunFailedError(failed), { note: "Approved" }, undefined)

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
