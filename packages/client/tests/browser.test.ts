import { afterEach, describe, expect, test } from "bun:test"
import {
  configureSixbBrowserClient,
  createSixbSignInUrl,
  type SixbBrowserRuntimeConfig,
} from "../src/browser"
import { client } from "../src/generated/client.gen"
import { requestSyncRun } from "../src/generated/sdk.gen"
import { createSixbEventsWebSocketUrl } from "../src/useSixbEvents"

const runtimeConfig: SixbBrowserRuntimeConfig = {
  api: { baseUrl: "http://localhost:3002" },
  auth: { audience: "app", enabled: true },
}

afterEach(() => {
  client.interceptors.request.clear()
  client.setConfig({ baseUrl: undefined, credentials: undefined })
})

describe("event websocket URLs", () => {
  test("defaults to the local Sixb API websocket origin", () => {
    expect(createSixbEventsWebSocketUrl()).toBe("ws://localhost:3002/ws/events")
  })

  test("derives the events websocket URL from an API base URL", () => {
    expect(createSixbEventsWebSocketUrl("http://localhost:3002/api")).toBe(
      "ws://localhost:3002/ws/events"
    )
    expect(createSixbEventsWebSocketUrl("https://api.example.com/v1?ignored=true")).toBe(
      "wss://api.example.com/ws/events"
    )
  })
})

describe("browser client auth", () => {
  test("creates API-origin sign-in URLs with audience and return target", () => {
    const url = new URL(createSixbSignInUrl(runtimeConfig, "http://localhost:3001/devices"))

    expect(url.origin).toBe("http://localhost:3002")
    expect(url.pathname).toBe("/auth/sign-in")
    expect(url.searchParams.get("audience")).toBe("app")
    expect(url.searchParams.get("returnTo")).toBe("http://localhost:3001/devices")
  })

  test("sends credentials and CSRF from memory for mutating requests", async () => {
    const controller = configureSixbBrowserClient(runtimeConfig)
    controller.setCsrfToken("csrf_1")
    const observedRequests: Request[] = []
    const fetchMock = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        observedRequests.push(input instanceof Request && !init ? input : new Request(input, init))
        return new Response(JSON.stringify({ id: "run_1", syncId: "sync_1", status: "queued" }), {
          headers: { "content-type": "application/json" },
        })
      },
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch

    await requestSyncRun({
      body: {},
      path: { syncId: "sync_1" },
      fetch: fetchMock,
    })

    const observedRequest = observedRequests[0]
    expect(observedRequest).toBeInstanceOf(Request)
    expect(observedRequest.url).toBe("http://localhost:3002/api/syncs/sync_1/runs")
    expect(observedRequest.credentials).toBe("include")
    expect(observedRequest.headers.get("x-sixb-csrf")).toBe("csrf_1")
  })
})
