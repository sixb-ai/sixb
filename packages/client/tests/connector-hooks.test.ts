import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import {
  getConnectorConnectionRunQueryKey,
  listConnectorConnectionsQueryKey,
} from "../src/generated/@tanstack/react-query.gen"
import { createClient, createConfig } from "../src/generated/client"
import type {
  GetConnectorConnectionRunResponse,
  SelectConnectorConnectionRunAccountResponse,
  StartConnectorConnectionRunResponse,
} from "../src/generated/types.gen"
import {
  connectConnectorMutationOptions,
  connectorConnectionRunQueryOptions,
  selectConnectorAccountMutationOptions,
} from "../src/hooks"

const startedRun: StartConnectorConnectionRunResponse = {
  runId: "ccr_1",
  authorizationUrl: "https://github.com/login/oauth/authorize?state=state",
  affectedConnections: [],
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

const succeededRun: SelectConnectorConnectionRunAccountResponse = {
  id: "ccr_1",
  connectorId: "github",
  kind: "connect",
  owner: { type: "project" },
  slot: "default",
  createdAt: "2026-08-24T12:00:00.000Z",
  updatedAt: "2026-08-24T12:02:00.000Z",
  status: "succeeded",
  connections: [
    {
      id: "ccn_1",
      connectorId: "github",
      owner: { type: "project" },
      slot: "default",
      account: { id: "octocat", label: "Octocat" },
      status: "connected",
    },
  ],
  finishedAt: "2026-08-24T12:02:00.000Z",
}

function createConnectorTestClient() {
  const requests: Array<{ method: string; path: string; body?: unknown }> = []
  const client = createClient(
    createConfig({
      baseUrl: "http://sixb.test",
      fetch: (async (request: Request) => {
        const url = new URL(request.url)
        const body = request.method === "POST" ? await request.json() : undefined
        requests.push({ method: request.method, path: url.pathname, body })

        if (
          request.method === "POST" &&
          url.pathname === "/api/connectors/github/connection-runs"
        ) {
          return Response.json(startedRun, { status: 201 })
        }
        if (
          request.method === "GET" &&
          url.pathname === "/api/connectors/github/connection-runs/ccr_1"
        ) {
          return Response.json(waitingRun)
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/connectors/github/connection-runs/ccr_1/selection"
        ) {
          return Response.json(succeededRun)
        }
        return Response.json({ error: "Unexpected request" }, { status: 500 })
      }) as unknown as typeof fetch,
    })
  )

  return { client, requests }
}

describe("connector connection hooks", () => {
  test("starts a run from domain inputs without exposing the generated request shape", async () => {
    const { client, requests } = createConnectorTestClient()
    const options = connectConnectorMutationOptions({
      client,
      connectorId: "github",
      slot: "default",
      returnTo: "https://app.sixb.test/settings/connectors",
    })
    const mutationFn = options.mutationFn as () => Promise<StartConnectorConnectionRunResponse>

    expect(await mutationFn()).toEqual(startedRun)
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/connectors/github/connection-runs",
        body: {
          slot: "default",
          returnTo: "https://app.sixb.test/settings/connectors",
        },
      },
    ])
  })

  test("resolves an app-relative return target against the current browser URL", async () => {
    const { client, requests } = createConnectorTestClient()
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://app.sixb.test/current?page=1"),
    })

    try {
      const options = connectConnectorMutationOptions({
        client,
        connectorId: "github",
        slot: "default",
        returnTo: "/settings/connectors",
      })
      const mutationFn = options.mutationFn as () => Promise<StartConnectorConnectionRunResponse>

      await mutationFn()
      expect(requests[0]?.body).toEqual({
        slot: "default",
        returnTo: "https://app.sixb.test/settings/connectors",
      })
    } finally {
      Reflect.deleteProperty(globalThis, "location")
    }
  })

  test("reads the resumed run through the generated cache key", async () => {
    const { client, requests } = createConnectorTestClient()
    const options = connectorConnectionRunQueryOptions({
      client,
      connectorId: "github",
      runId: "ccr_1",
    })
    const queryFn = options.queryFn as unknown as (context: {
      signal?: AbortSignal
    }) => Promise<GetConnectorConnectionRunResponse>

    expect(options.queryKey as unknown).toEqual([
      {
        _id: "getConnectorConnectionRun",
        path: { connectorId: "github", runId: "ccr_1" },
      },
    ])
    expect(await queryFn({})).toEqual(waitingRun)
    expect(requests[0]).toEqual({
      method: "GET",
      path: "/api/connectors/github/connection-runs/ccr_1",
      body: undefined,
    })
  })

  test("keeps the run query idle before the callback provides a run id", () => {
    const options = connectorConnectionRunQueryOptions({
      connectorId: "github",
      runId: null,
    })

    expect(options.enabled).toBe(false)
  })

  test("selects an account and converges the related caches", async () => {
    const { client, requests } = createConnectorTestClient()
    const queryClient = new QueryClient()
    const runQueryKey = getConnectorConnectionRunQueryKey({
      path: { connectorId: "github", runId: "ccr_1" },
    })
    const connectionsQueryKey = listConnectorConnectionsQueryKey({
      path: { connectorId: "github" },
    })
    queryClient.setQueryData(runQueryKey, waitingRun)
    queryClient.setQueryData(connectionsQueryKey, [])
    const options = selectConnectorAccountMutationOptions({
      client,
      queryClient,
      connectorId: "github",
      runId: "ccr_1",
    })
    const mutationFn = options.mutationFn as (input: {
      accountId: string
      replace?: boolean
    }) => Promise<SelectConnectorConnectionRunAccountResponse>

    const result = await mutationFn({ accountId: "octocat", replace: true })
    await options.onSuccess?.(
      result,
      { accountId: "octocat", replace: true },
      undefined,
      {} as never
    )

    expect(result).toEqual(succeededRun)
    expect(requests[0]).toEqual({
      method: "POST",
      path: "/api/connectors/github/connection-runs/ccr_1/selection",
      body: { accountId: "octocat", replace: true },
    })
    expect(
      queryClient.getQueryData<SelectConnectorConnectionRunAccountResponse>(runQueryKey)
    ).toEqual(succeededRun)
    expect(queryClient.getQueryState(connectionsQueryKey)?.isInvalidated).toBe(true)
  })
})
