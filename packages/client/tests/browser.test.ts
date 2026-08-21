import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import {
  createSixbAgentsWebSocketUrl,
  parseAgentRunStreamServerMessage,
} from "../src/agent-streams"
import { SIXB_CSRF_TOKEN_RESPONSE_HEADER_NAME } from "../src/api"
import {
  configureSixbBrowserClient,
  createSixbSignInUrl,
  isSixbApiError,
  requireSixbBrowserAuthSession,
  type SixbBrowserClientController,
  type SixbBrowserClientOptions,
  type SixbBrowserRuntimeConfig,
} from "../src/browser"
import { createSixbEventsWebSocketUrl } from "../src/events-transport"
import { client } from "../src/generated/client.gen"
import {
  listAuthMembers,
  listAuthSessions,
  requestSyncRun,
  signOut,
} from "../src/generated/sdk.gen"

const runtimeConfig: SixbBrowserRuntimeConfig = {
  api: { baseUrl: "http://localhost:3002" },
  auth: { audience: "app", enabled: true },
}

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
const controllers: SixbBrowserClientController[] = []

class TestDocument extends EventTarget {
  visibilityState: DocumentVisibilityState

  constructor(visibilityState: DocumentVisibilityState) {
    super()
    this.visibilityState = visibilityState
  }

  setVisibility(visibilityState: DocumentVisibilityState): void {
    this.visibilityState = visibilityState
    this.dispatchEvent(new Event("visibilitychange"))
  }
}

function installDocument(visibilityState: DocumentVisibilityState): TestDocument {
  const testDocument = new TestDocument(visibilityState)
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: testDocument,
  })
  return testDocument
}

function configureBrowserClient(
  options?: SixbBrowserClientOptions,
  config: SixbBrowserRuntimeConfig = runtimeConfig
): SixbBrowserClientController {
  const controller = configureSixbBrowserClient(config, options)
  controllers.push(controller)
  return controller
}

async function observeSyncRequest(headers?: Record<string, string>): Promise<Request> {
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
    headers,
  })
  return observedRequests[0]
}

afterEach(() => {
  while (controllers.length > 0) controllers.pop()?.dispose()
  setSystemTime()
  if (originalDocument) {
    Object.defineProperty(globalThis, "document", originalDocument)
  } else {
    Reflect.deleteProperty(globalThis, "document")
  }
  client.interceptors.request.clear()
  client.interceptors.response.clear()
  client.setConfig({
    auth: undefined,
    baseUrl: undefined,
    credentials: undefined,
    fetch: undefined,
  })
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

describe("agent stream websocket helpers", () => {
  test("defaults to the local Sixb API websocket origin", () => {
    expect(createSixbAgentsWebSocketUrl()).toBe("ws://localhost:3002/ws/agents")
  })

  test("derives the agents websocket URL from an API base URL", () => {
    expect(createSixbAgentsWebSocketUrl("http://localhost:3002/api")).toBe(
      "ws://localhost:3002/ws/agents"
    )
    expect(createSixbAgentsWebSocketUrl("https://api.example.com/v1?ignored=true")).toBe(
      "wss://api.example.com/ws/agents"
    )
  })

  test("parses valid records while keeping UI chunks opaque", () => {
    const parsed = parseAgentRunStreamServerMessage(
      JSON.stringify({
        type: "record",
        record: {
          streamId: "agents.runs.run_1",
          cursor: "cursor_1",
          name: "agent.ui.chunk",
          key: "run_1",
          publishedAt: "2026-06-27T16:00:00.000Z",
          payload: {
            schemaVersion: 1,
            type: "agent.ui.chunk",
            projectId: "project_1",
            runId: "run_1",
            threadId: "thread_1",
            agentId: "agent_1",
            attempt: 1,
            occurredAt: "2026-06-27T16:00:00.000Z",
            chunkIndex: 0,
            chunk: { future: ["shape"] },
          },
        },
      })
    )

    expect(parsed?.type).toBe("record")
    expect(parsed?.type === "record" ? parsed.record.cursor : null).toBe("cursor_1")
  })

  test("preserves the durable failure on terminal Agent records", () => {
    const failure = {
      code: "internal.unexpected",
      message: "provider unavailable",
      retryable: false,
      at: "2026-06-27T15:59:59.000Z",
      details: { agentId: "agent_1", runId: "run_1" },
    } as const
    const frame = {
      type: "record",
      record: {
        streamId: "agents.runs.run_1",
        cursor: "cursor_2",
        name: "agent.run.finished",
        key: "run_1",
        publishedAt: "2026-06-27T16:00:00.000Z",
        payload: {
          schemaVersion: 1,
          type: "agent.run.finished",
          projectId: "project_1",
          runId: "run_1",
          threadId: "thread_1",
          agentId: "agent_1",
          attempt: 1,
          occurredAt: "2026-06-27T16:00:00.000Z",
          status: "failed",
          finishReason: "error",
          error: failure,
        },
      },
    }

    const parsed = parseAgentRunStreamServerMessage(JSON.stringify(frame))
    const payload = parsed?.type === "record" ? parsed.record.payload : null
    expect(payload?.type === "agent.run.finished" ? payload.error : null).toEqual(failure)

    const flattened = {
      ...frame,
      record: {
        ...frame.record,
        payload: { ...frame.record.payload, error: "provider unavailable" },
      },
    }
    expect(parseAgentRunStreamServerMessage(JSON.stringify(flattened))).toBeNull()
  })

  test("drops malformed frames without throwing", () => {
    expect(parseAgentRunStreamServerMessage("not json")).toBeNull()
    expect(
      parseAgentRunStreamServerMessage(JSON.stringify({ type: "record", record: {} }))
    ).toBeNull()
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
    const controller = configureBrowserClient()
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

  test("marks requests made during visible startup activity", async () => {
    installDocument("visible")
    setSystemTime(new Date("2026-07-01T10:00:00.000Z"))
    configureBrowserClient()

    const request = await observeSyncRequest({ "x-sixb-session-activity": "wrong" })

    expect(request.headers.get("x-sixb-session-activity")).toBe("1")
  })

  test("removes the activity header while the document is hidden", async () => {
    installDocument("hidden")
    setSystemTime(new Date("2026-07-01T10:00:00.000Z"))
    configureBrowserClient()

    const request = await observeSyncRequest({ "x-sixb-session-activity": "1" })

    expect(request.headers.has("x-sixb-session-activity")).toBe(false)
  })

  test("expires activity at five minutes and records returning visibility", async () => {
    const testDocument = installDocument("visible")
    const startedAt = new Date("2026-07-01T10:00:00.000Z")
    setSystemTime(startedAt)
    configureBrowserClient()

    setSystemTime(new Date(startedAt.getTime() + 5 * 60_000 - 1))
    expect((await observeSyncRequest()).headers.get("x-sixb-session-activity")).toBe("1")

    setSystemTime(new Date(startedAt.getTime() + 5 * 60_000))
    expect((await observeSyncRequest()).headers.has("x-sixb-session-activity")).toBe(false)

    testDocument.setVisibility("hidden")
    expect((await observeSyncRequest()).headers.has("x-sixb-session-activity")).toBe(false)

    testDocument.setVisibility("visible")
    expect((await observeSyncRequest()).headers.get("x-sixb-session-activity")).toBe("1")
  })

  test("records pointer, keyboard, and touch activity only while visible", async () => {
    const testDocument = installDocument("visible")
    const startedAt = new Date("2026-07-01T10:00:00.000Z")
    setSystemTime(startedAt)
    configureBrowserClient()

    for (const [index, eventType] of ["pointerdown", "keydown", "touchstart"].entries()) {
      setSystemTime(new Date(startedAt.getTime() + (index + 1) * 6 * 60_000))
      expect((await observeSyncRequest()).headers.has("x-sixb-session-activity")).toBe(false)
      testDocument.dispatchEvent(new Event(eventType))
      expect((await observeSyncRequest()).headers.get("x-sixb-session-activity")).toBe("1")
    }

    testDocument.setVisibility("hidden")
    testDocument.dispatchEvent(new Event("pointerdown"))
    expect((await observeSyncRequest()).headers.has("x-sixb-session-activity")).toBe(false)
  })

  test("dispose removes activity behavior and is idempotent", async () => {
    const testDocument = installDocument("visible")
    setSystemTime(new Date("2026-07-01T10:00:00.000Z"))
    const controller = configureBrowserClient()

    controller.dispose()
    controller.dispose()
    testDocument.dispatchEvent(new Event("pointerdown"))

    expect((await observeSyncRequest()).headers.has("x-sixb-session-activity")).toBe(false)
  })

  test("redirects once on a 401 without replaying the failed mutation", async () => {
    const redirects: string[] = []
    const currentUrl = "http://localhost:3001/devices?status=active#fan-1"
    const controller = configureBrowserClient({
      getCurrentUrl: () => currentUrl,
      redirect: (url) => redirects.push(url),
    })
    controller.setCsrfToken("csrf_stale")
    let fetchCount = 0
    const fetchMock = Object.assign(
      async () => {
        fetchCount += 1
        return Response.json({ error: "Authentication required" }, { status: 401 })
      },
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch

    const error = await requestSyncRun({
      body: {},
      path: { syncId: "sync_1" },
      fetch: fetchMock,
      throwOnError: true,
    }).catch((caught) => caught)

    expect(fetchCount).toBe(1)
    expect(controller.getCsrfToken()).toBeNull()
    expect(isSixbApiError(error)).toBe(true)
    expect(error).toMatchObject({ status: 401 })
    expect(redirects).toHaveLength(1)
    const redirect = new URL(redirects[0])
    expect(redirect.pathname).toBe("/auth/sign-in")
    expect(redirect.searchParams.get("audience")).toBe("app")
    expect(redirect.searchParams.get("returnTo")).toBe(currentUrl)
  })

  test("replaces the previous browser controller without stale cleanup breaking the active one", async () => {
    const firstRedirects: string[] = []
    const secondRedirects: string[] = []
    const first = configureBrowserClient({
      getCurrentUrl: () => "http://localhost:3001/first",
      redirect: (url) => firstRedirects.push(url),
    })
    const second = configureBrowserClient({
      getCurrentUrl: () => "http://localhost:3001/second",
      redirect: (url) => secondRedirects.push(url),
    })

    first.dispose()
    second.setCsrfToken("csrf_active")
    const request = await observeSyncRequest()
    expect(request.credentials).toBe("include")
    expect(request.headers.get("x-sixb-csrf")).toBe("csrf_active")

    const fetchMock = Object.assign(
      async () => Response.json({ error: "Authentication required" }, { status: 401 }),
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch
    await requestSyncRun({ body: {}, path: { syncId: "sync_1" }, fetch: fetchMock })

    expect(firstRedirects).toEqual([])
    expect(secondRedirects).toHaveLength(1)
  })

  test("does not auto-redirect explicit sign-out requests", async () => {
    const redirects: string[] = []
    const controller = configureBrowserClient({
      getCurrentUrl: () => "http://localhost:3001/devices",
      redirect: (url) => redirects.push(url),
    })
    controller.setCsrfToken("csrf_current")
    const fetchMock = Object.assign(
      async () => Response.json({ error: "Authentication required" }, { status: 401 }),
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch

    await signOut({ fetch: fetchMock })

    expect(controller.getCsrfToken()).toBe("csrf_current")
    expect(redirects).toEqual([])
  })

  test("does not auto-redirect path-prefixed sign-out requests", async () => {
    const redirects: string[] = []
    configureBrowserClient(
      {
        getCurrentUrl: () => "http://localhost:3001/devices",
        redirect: (url) => redirects.push(url),
      },
      { ...runtimeConfig, api: { baseUrl: "http://localhost:3002/platform" } }
    )
    let requestUrl = ""
    const fetchMock = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        requestUrl = input instanceof Request ? input.url : String(input)
        return Response.json({ error: "Authentication required" }, { status: 401 })
      },
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch

    await signOut({ fetch: fetchMock })

    expect(new URL(requestUrl).pathname).toBe("/platform/api/auth/sign-out")
    expect(redirects).toEqual([])
  })

  test("auto-redirects protected auth session management requests", async () => {
    const redirects: string[] = []
    configureBrowserClient({
      getCurrentUrl: () => "http://localhost:3001/settings/sessions",
      redirect: (url) => redirects.push(url),
    })
    const fetchMock = Object.assign(
      async () => Response.json({ error: "Authentication required" }, { status: 401 }),
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch

    await listAuthSessions({ fetch: fetchMock })

    expect(redirects).toHaveLength(1)
  })

  test("auto-redirects protected auth member management requests", async () => {
    const redirects: string[] = []
    configureBrowserClient({
      getCurrentUrl: () => "http://localhost:3001/settings/members",
      redirect: (url) => redirects.push(url),
    })
    const fetchMock = Object.assign(
      async () => Response.json({ error: "Authentication required" }, { status: 401 }),
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch

    await listAuthMembers({ fetch: fetchMock })

    expect(redirects).toHaveLength(1)
  })

  test("synchronizes CSRF state from a response header", async () => {
    const controller = configureBrowserClient()
    controller.setCsrfToken("csrf_stale")
    const fetchMock = Object.assign(
      async () =>
        Response.json(
          { id: "run_1", syncId: "sync_1", status: "queued" },
          { headers: { [SIXB_CSRF_TOKEN_RESPONSE_HEADER_NAME]: "csrf_current" } }
        ),
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch

    await requestSyncRun({ body: {}, path: { syncId: "sync_1" }, fetch: fetchMock })

    expect(controller.getCsrfToken()).toBe("csrf_current")
  })

  test("does not auto-redirect bearer requests", async () => {
    const redirects: string[] = []
    const controller = configureBrowserClient({
      getCurrentUrl: () => "http://localhost:3001/devices",
      redirect: (url) => redirects.push(url),
    })
    controller.setCsrfToken("csrf_current")
    const fetchMock = Object.assign(
      async () => Response.json({ error: "Authentication required" }, { status: 401 }),
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch

    await requestSyncRun({
      body: {},
      path: { syncId: "sync_1" },
      headers: { authorization: "Bearer token_1" },
      fetch: fetchMock,
    })

    expect(controller.getCsrfToken()).toBe("csrf_current")
    expect(redirects).toEqual([])
  })

  test("retries redirecting after navigation fails", async () => {
    let redirectAttempts = 0
    configureBrowserClient({
      getCurrentUrl: () => "http://localhost:3001/devices",
      redirect: () => {
        redirectAttempts += 1
        throw new Error("navigation failed")
      },
    })
    const fetchMock = Object.assign(
      async () => Response.json({ error: "Authentication required" }, { status: 401 }),
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch

    await requestSyncRun({ body: {}, path: { syncId: "sync_1" }, fetch: fetchMock })
    await requestSyncRun({ body: {}, path: { syncId: "sync_2" }, fetch: fetchMock })

    expect(redirectAttempts).toBe(2)
  })

  test("deduplicates concurrent 401 redirects", async () => {
    const redirects: string[] = []
    configureBrowserClient({
      getCurrentUrl: () => "http://localhost:3001/devices",
      redirect: (url) => redirects.push(url),
    })
    const fetchMock = Object.assign(
      async () => Response.json({ error: "Authentication required" }, { status: 401 }),
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch

    await Promise.allSettled([
      requestSyncRun({ body: {}, path: { syncId: "sync_1" }, fetch: fetchMock }),
      requestSyncRun({ body: {}, path: { syncId: "sync_2" }, fetch: fetchMock }),
    ])

    expect(redirects).toHaveLength(1)
  })

  test("does not auto-redirect when auth is disabled or already on an auth page", async () => {
    const redirects: string[] = []
    const fetchMock = Object.assign(
      async () => Response.json({ error: "Authentication required" }, { status: 401 }),
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch
    configureBrowserClient(
      {
        getCurrentUrl: () => "http://localhost:3001/devices",
        redirect: (url) => redirects.push(url),
      },
      { ...runtimeConfig, auth: { ...runtimeConfig.auth, enabled: false } }
    )

    await requestSyncRun({ body: {}, path: { syncId: "sync_1" }, fetch: fetchMock })
    expect(redirects).toEqual([])

    controllers.pop()?.dispose()
    configureBrowserClient({
      getCurrentUrl: () => "http://localhost:3002/auth/sign-in",
      redirect: (url) => redirects.push(url),
    })
    await requestSyncRun({ body: {}, path: { syncId: "sync_2" }, fetch: fetchMock })
    expect(redirects).toEqual([])
  })

  test("initial unauthenticated bootstrap uses its explicit redirect path", async () => {
    const automaticRedirects: string[] = []
    const bootstrapRedirects: string[] = []
    const controller = configureBrowserClient({
      getCurrentUrl: () => "http://localhost:3001/devices",
      redirect: (url) => automaticRedirects.push(url),
    })
    controller.setCsrfToken("csrf_stale")
    const fetchMock = Object.assign(async () => Response.json({ authenticated: false }), {
      preconnect: fetch.preconnect,
    }) satisfies typeof fetch
    client.setConfig({ fetch: fetchMock })

    await requireSixbBrowserAuthSession(runtimeConfig, controller, {
      returnTo: "http://localhost:3001/devices",
      redirect: (url) => bootstrapRedirects.push(url),
    })

    expect(controller.getCsrfToken()).toBeNull()
    expect(automaticRedirects).toEqual([])
    expect(bootstrapRedirects).toHaveLength(1)
  })

  test("dispose removes expired-session redirect handling", async () => {
    const redirects: string[] = []
    const controller = configureBrowserClient({
      getCurrentUrl: () => "http://localhost:3001/devices",
      redirect: (url) => redirects.push(url),
    })
    controller.dispose()
    const fetchMock = Object.assign(
      async () => Response.json({ error: "Authentication required" }, { status: 401 }),
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch

    await requestSyncRun({ body: {}, path: { syncId: "sync_1" }, fetch: fetchMock })

    expect(redirects).toEqual([])
  })
})
