import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { Window } from "happy-dom"
import type { PropsWithChildren } from "react"
import { SixbProvider } from "../src/client-provider"
import {
  isConnectorReplacementRequired,
  useConnectorConnection,
} from "../src/connectors/connection"
import {
  getConnectorConnectionRunQueryKey,
  listConnectorConnectionsQueryKey,
  listPendingConnectorConnectionRunsOptions,
  listPendingConnectorConnectionRunsQueryKey,
} from "../src/generated/@tanstack/react-query.gen"
import { type Client, createClient, createConfig } from "../src/generated/client"
import type {
  GetConnectorConnectionRunResponse,
  ListConnectorConnectionsResponse,
} from "../src/generated/types.gen"

const browserWindow = new Window({ url: "https://app.sixb.test/settings" })
const installedBrowserGlobals = [
  "window",
  "self",
  "document",
  "location",
  "history",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "EventTarget",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const
const previousBrowserGlobals = new Map<string, PropertyDescriptor | undefined>()

const connection = {
  id: "ccn_1",
  connectorId: "github",
  owner: { type: "project" },
  slot: "default",
  account: { id: "octocat", label: "Octocat" },
  status: "connected",
} as const

const succeededRun: GetConnectorConnectionRunResponse = {
  id: "ccr_1",
  connectorId: "github",
  kind: "connect",
  owner: { type: "project" },
  slot: "default",
  createdAt: "2026-08-24T12:00:00.000Z",
  updatedAt: "2026-08-24T12:02:00.000Z",
  status: "succeeded",
  connections: [connection],
  finishedAt: "2026-08-24T12:02:00.000Z",
}

const waitingRun: GetConnectorConnectionRunResponse = {
  id: "ccr_1",
  connectorId: "github",
  kind: "connect",
  owner: { type: "project" },
  slot: "default",
  createdAt: "2026-08-24T12:00:00.000Z",
  updatedAt: "2026-08-24T12:01:00.000Z",
  status: "waiting",
  waitingFor: "account_selection",
  accounts: [{ id: "octocat", label: "Octocat" }],
}

beforeAll(() => {
  const values = browserWindow as unknown as Record<string, unknown>
  for (const key of installedBrowserGlobals) {
    previousBrowserGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    const value =
      key === "window" || key === "self"
        ? browserWindow
        : key === "IS_REACT_ACT_ENVIRONMENT"
          ? true
          : values[key]
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
})

beforeEach(() => {
  browserWindow.history.replaceState({}, "", "/settings")
  browserWindow.document.body.replaceChildren()
})

afterEach(async () => {
  cleanup()
  await Bun.sleep(0)
})

afterAll(async () => {
  await Bun.sleep(0)
  for (const key of installedBrowserGlobals) {
    const previous = previousBrowserGlobals.get(key)
    if (previous) Object.defineProperty(globalThis, key, previous)
    else Reflect.deleteProperty(globalThis, key)
  }
  browserWindow.close()
})

describe("useConnectorConnection", () => {
  test("completion refreshes other pending-run consumers using the provider client", async () => {
    // Remove providerClient from completion's invalidation key: the observer keeps waitingRun.
    browserWindow.history.replaceState(
      {},
      "",
      "/settings?connectionConnectorId=github&connectionRunId=ccr_1"
    )
    let pendingReads = 0
    const { client } = createHookClient(
      async () => Response.json([connection]),
      () => {
        pendingReads++
        return Response.json([])
      }
    )
    const queryClient = connectorQueryClient()
    seedConnectorQueries(queryClient, succeededRun, [connection])
    const options = listPendingConnectorConnectionRunsOptions({
      client,
      path: { connectorId: "github" },
    })
    const globalKey = listPendingConnectorConnectionRunsQueryKey({
      path: { connectorId: "github" },
    })
    expect(options.queryKey).not.toEqual(globalKey)
    queryClient.setQueryData(options.queryKey, [waitingRun])
    queryClient.setQueryData(globalKey, [waitingRun])
    const observer = new QueryObserver(queryClient, { ...options, staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => {})
    try {
      renderHook(() => useConnectorConnection({ connectorId: "github", slot: "default" }), {
        wrapper: connectorWrapper(client, queryClient),
      })
      await waitFor(() => expect(observer.getCurrentResult().data).toEqual([]))
      expect(pendingReads).toBeGreaterThan(0)
      expect(queryClient.getQueryState(globalKey)?.isInvalidated).toBe(false)
    } finally {
      unsubscribe()
    }
  })

  test("reopening Settings resumes pending company selection and completes without OAuth", async () => {
    // Remove pending-run discovery from the hook: it never reaches selecting_account.
    let selected = false
    const { client, requests } = createHookClient(
      async (request) => {
        const path = new URL(request.url).pathname
        if (path.endsWith("/selection")) {
          selected = true
          return Response.json(succeededRun)
        }
        if (path.endsWith("/connection-runs/ccr_1"))
          return Response.json(selected ? succeededRun : waitingRun)
        if (path.endsWith("/connections")) return Response.json(selected ? [connection] : [])
        return Response.json({ error: "Unexpected request" }, { status: 500 })
      },
      () =>
        Response.json(
          selected ? [] : [{ ...waitingRun, id: "other-slot", slot: "other" }, waitingRun]
        )
    )
    const rendered = renderHook(
      () => useConnectorConnection({ connectorId: "github", slot: "default" }),
      {
        wrapper: connectorWrapper(client, connectorQueryClient()),
      }
    )
    await waitFor(() => expect(rendered.result.current.status).toBe("selecting_account"))
    expect(browserWindow.location.search).toBe("")
    expect(rendered.result.current.accounts).toEqual(waitingRun.accounts)
    expect(rendered.result.current.canConnect).toBe(false)
    await act(async () => {
      await rendered.result.current.selectAccount("octocat")
    })
    await waitFor(() => expect(rendered.result.current.status).toBe("connected"))
    expect(
      requests
        .filter((request) => request.method === "POST")
        .map((request) => new URL(request.url).pathname)
    ).toEqual(["/api/connectors/github/connection-runs/ccr_1/selection"])
  })

  test("surfaces a failed recovery lookup before offering another authorization", async () => {
    const { client } = createHookClient(
      async () => Response.json([]),
      () => Response.json({ error: "Unavailable" }, { status: 503 })
    )
    const rendered = renderHook(
      () => useConnectorConnection({ connectorId: "github", slot: "default" }),
      {
        wrapper: connectorWrapper(client, connectorQueryClient()),
      }
    )
    await waitFor(() => expect(rendered.result.current.status).toBe("error"))
    expect(rendered.result.current.canConnect).toBe(false)
  })

  test("consumes a completed callback after refresh recovers from a connection read failure", async () => {
    browserWindow.history.replaceState(
      {},
      "",
      "/settings?tab=connectors&connectionConnectorId=github&connectionRunId=ccr_1#oauth"
    )
    let connectionReads = 0
    const { client } = createHookClient(async (request) => {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname.endsWith("/connections")) {
        connectionReads += 1
        if (connectionReads === 1) {
          return Response.json({ error: "Temporary outage" }, { status: 503 })
        }
        return Response.json([connection])
      }
      if (request.method === "GET" && url.pathname.endsWith("/connection-runs/ccr_1")) {
        return Response.json(succeededRun)
      }
      return Response.json({ error: "Unexpected request" }, { status: 500 })
    })
    const queryClient = connectorQueryClient()
    seedConnectorQueries(queryClient, succeededRun, [])
    const rendered = renderHook(
      () => useConnectorConnection({ connectorId: "github", slot: "default" }),
      { wrapper: connectorWrapper(client, queryClient) }
    )

    await waitFor(() => expect(connectionReads).toBe(1))
    expect(rendered.result.current.status).toBe("authorizing")
    expect(browserWindow.location.search).toContain("connectionRunId=ccr_1")

    await act(async () => rendered.result.current.refresh())

    await waitFor(() => expect(rendered.result.current.status).toBe("connected"))
    expect(connectionReads).toBe(2)
    expect(browserWindow.location.href).toBe("https://app.sixb.test/settings?tab=connectors#oauth")
  })

  test("does not start another authorization while account selection is pending", async () => {
    browserWindow.history.replaceState(
      {},
      "",
      "/settings?connectionConnectorId=github&connectionRunId=ccr_1"
    )
    const { client, requests } = createHookClient(async () =>
      Response.json({ error: "Unexpected request" }, { status: 500 })
    )
    const queryClient = connectorQueryClient()
    seedConnectorQueries(queryClient, waitingRun, [])
    const rendered = renderHook(
      () => useConnectorConnection({ connectorId: "github", slot: "default" }),
      { wrapper: connectorWrapper(client, queryClient) }
    )

    expect(rendered.result.current.status).toBe("selecting_account")
    expect(rendered.result.current.canConnect).toBe(false)
    await act(async () => rendered.result.current.connect())

    expect(requests).toEqual([])
    expect(rendered.result.current.status).toBe("selecting_account")
  })

  test("coalesces concurrent connect calls into one authorization request", async () => {
    let releaseRequest: (response: Response) => void = () => undefined
    const providerResponse = new Promise<Response>((resolve) => {
      releaseRequest = resolve
    })
    let markRequestStarted: () => void = () => undefined
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve
    })
    const { client, requests } = createHookClient(async () => {
      markRequestStarted()
      return providerResponse
    })
    const queryClient = connectorQueryClient()
    queryClient.setQueryData(
      listConnectorConnectionsQueryKey({ path: { connectorId: "github" } }),
      []
    )
    const rendered = renderHook(
      () => useConnectorConnection({ connectorId: "github", slot: "default" }),
      { wrapper: connectorWrapper(client, queryClient) }
    )

    await waitFor(() => expect(rendered.result.current.canConnect).toBe(true))
    let first!: Promise<void>
    let second!: Promise<void>
    await act(async () => {
      first = rendered.result.current.connect()
      second = rendered.result.current.connect()
      await requestStarted
      await Bun.sleep(0)
    })

    try {
      expect(first).toBe(second)
      expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
    } finally {
      await act(async () => {
        releaseRequest(Response.json({ error: "Temporary outage" }, { status: 503 }))
        await Promise.allSettled([first, second])
        await Bun.sleep(0)
      })
    }
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
  })
})

describe("connector replacement errors", () => {
  test("distinguishes replacement from unrelated operation conflicts", () => {
    expect(isConnectorReplacementRequired({ code: "connector.replacement_required" })).toBe(true)
    expect(isConnectorReplacementRequired({ code: "connector.operation_conflict" })).toBe(false)
  })
})

function connectorQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })
}

function seedConnectorQueries(
  queryClient: QueryClient,
  run: GetConnectorConnectionRunResponse,
  connections: ListConnectorConnectionsResponse
): void {
  queryClient.setQueryData(
    getConnectorConnectionRunQueryKey({
      path: { connectorId: "github", runId: "ccr_1" },
    }),
    run
  )
  queryClient.setQueryData(
    listConnectorConnectionsQueryKey({ path: { connectorId: "github" } }),
    connections
  )
}

function connectorWrapper(client: Client, queryClient: QueryClient) {
  return function ConnectorWrapper({ children }: PropsWithChildren) {
    return (
      <SixbProvider client={client}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </SixbProvider>
    )
  }
}

function createHookClient(
  handler: (request: Request) => Promise<Response>,
  pending: () => Response = () => Response.json([])
) {
  const requests: Request[] = []
  const client = createClient(
    createConfig({
      baseUrl: "https://api.sixb.test",
      fetch: (async (request: Request) => {
        requests.push(request)
        if (request.method === "GET" && new URL(request.url).pathname.endsWith("/connection-runs"))
          return pending()
        return handler(request)
      }) as unknown as typeof fetch,
    })
  )
  return { client, requests }
}
