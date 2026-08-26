import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
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
  expiresAt: "2026-08-24T12:10:00.000Z",
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

    expect(rendered.result.current.canConnect).toBe(true)
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
      expect(requests).toHaveLength(1)
    } finally {
      await act(async () => {
        releaseRequest(Response.json({ error: "Temporary outage" }, { status: 503 }))
        await Promise.allSettled([first, second])
        await Bun.sleep(0)
      })
    }
    expect(requests).toHaveLength(1)
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

function createHookClient(handler: (request: Request) => Promise<Response>) {
  const requests: Request[] = []
  const client = createClient(
    createConfig({
      baseUrl: "https://api.sixb.test",
      fetch: (async (request: Request) => {
        requests.push(request)
        return handler(request)
      }) as unknown as typeof fetch,
    })
  )
  return { client, requests }
}
