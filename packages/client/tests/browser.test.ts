import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { takeActivityArrival } from "../src/activity-attribution"
import {
  createSixbAgentsWebSocketUrl,
  parseAgentRunStreamServerMessage,
} from "../src/agent-streams"
import { SIXB_CSRF_TOKEN_RESPONSE_HEADER_NAME } from "../src/api"
import {
  configureSixbBrowserClient,
  configureSixbSharedBrowserClient,
  isSixbApiError,
  requireSixbBrowserAuthSession,
  type SixbBrowserClientController,
  type SixbBrowserClientOptions,
  type SixbBrowserRuntimeConfig,
} from "../src/browser"
import { createSixbEventsWebSocketUrl } from "../src/events-transport"
import { objectFileContentUrl } from "../src/file"
import { client } from "../src/generated/client.gen"
import {
  captureActivity,
  getActivityCaptureConfig,
  listAuthSessions,
  requestAction,
  requestSyncRun,
  signOut,
} from "../src/generated/sdk.gen"

const runtimeConfig: SixbBrowserRuntimeConfig = {
  api: { baseUrl: "http://localhost:3002" },
  auth: { enabled: true },
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

describe("websocket URLs", () => {
  test("default to the local Sixb API and derive the stream path from an API base URL", () => {
    expect(createSixbEventsWebSocketUrl()).toBe("ws://localhost:3002/ws/events")
    expect(createSixbAgentsWebSocketUrl()).toBe("ws://localhost:3002/ws/agents")
    expect(createSixbEventsWebSocketUrl("http://localhost:3002/api")).toBe(
      "ws://localhost:3002/ws/events"
    )
    expect(createSixbAgentsWebSocketUrl("https://api.example.com/v1?ignored=true")).toBe(
      "wss://api.example.com/ws/agents"
    )
  })
})

describe("agent stream frames", () => {
  test("parses valid UI chunk records", () => {
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
            chunk: { type: "text-delta", id: "text", delta: "Hi" },
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

describe("shared browser client", () => {
  test("exchanges, resumes, mutates, and signs out through the ordinary singleton", async () => {
    installDocument("visible")
    setSystemTime(new Date("2026-08-29T10:00:00.000Z"))
    const csrfToken = "C".repeat(43)
    const session = {
      grantId: "shr_1",
      destinationPath: "/proposals/proposal-1",
      expiresAt: "2026-08-29T10:15:00.000Z",
      absoluteExpiresAt: "2026-08-30T10:00:00.000Z",
      csrfToken,
    }
    const requests: Request[] = []
    const fetchMock = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = input instanceof Request && !init ? input : new Request(input, init)
        requests.push(request.clone())
        const pathname = new URL(request.url).pathname
        if (pathname.endsWith("/exchange") || pathname.endsWith("/session")) {
          return Response.json(session, {
            headers: { [SIXB_CSRF_TOKEN_RESPONSE_HEADER_NAME]: csrfToken },
          })
        }
        if (pathname.endsWith("/sign-out")) return Response.json({ signedOut: true })
        return Response.json({ id: "run_1", status: "succeeded" })
      },
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch
    const controller = configureSixbSharedBrowserClient(runtimeConfig, {
      grantId: "shr_1",
      fetch: fetchMock,
    })
    controllers.push(controller)

    await controller.establish("S".repeat(43))
    await controller.getSession()
    await requestAction({
      path: { actionId: "approve" },
      body: { subject: { kind: "none" } },
    })
    await controller.signOut()

    expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "POST", "POST"])
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/api/shared-access/shr_1/exchange")
    expect(await requests[0]?.json()).toEqual({ secret: "S".repeat(43) })
    expect(new URL(requests[1]?.url ?? "").pathname).toBe("/api/shared-access/shr_1/session")
    expect(new URL(requests[2]?.url ?? "").pathname).toBe("/api/actions/approve")
    expect(new URL(requests[3]?.url ?? "").pathname).toBe("/api/shared-access/shr_1/sign-out")
    for (const request of requests) {
      expect(request.credentials).toBe("include")
      expect(request.headers.get("authorization")).toBeNull()
      expect(request.headers.get("x-sixb-share-grant")).toBe("shr_1")
      expect(request.headers.get("x-sixb-session-activity")).toBe("1")
    }
    expect(requests[0]?.headers.get("x-sixb-csrf")).toBeNull()
    expect(requests[1]?.headers.get("x-sixb-csrf")).toBeNull()
    expect(requests[2]?.headers.get("x-sixb-csrf")).toBe(csrfToken)
    expect(requests[3]?.headers.get("x-sixb-csrf")).toBe(csrfToken)
    expect(controller.getCsrfToken()).toBeNull()

    // File URLs feed <img>/<video> elements, which cannot carry the selector header.
    const fileUrl = () =>
      new URL(
        objectFileContentUrl({
          objectTypeId: "report",
          objectId: "report-1",
          pathSegments: ["video"],
          fileRef: {
            blobId: `blob_${"a".repeat(64)}`,
            digest: `sha256:${"a".repeat(64)}`,
            sizeBytes: 1,
          },
        }),
        "http://localhost:3001"
      )
    expect(fileUrl().searchParams.get("shareGrant")).toBe("shr_1")

    controller.dispose()
    expect(client.getConfig().fetch).toBeUndefined()
    expect(fileUrl().searchParams.has("shareGrant")).toBe(false)
  })

  test("rejects malformed secrets before making a request", async () => {
    let fetchCalled = false
    const controller = configureSixbSharedBrowserClient(runtimeConfig, {
      grantId: "shr_1",
      fetch: Object.assign(
        async () => {
          fetchCalled = true
          return Response.json({})
        },
        { preconnect: fetch.preconnect }
      ),
    })
    controllers.push(controller)

    await expect(controller.exchange("short")).rejects.toThrow("Shared access secret is invalid")
    expect(fetchCalled).toBe(false)
  })

  test("rejects a non-same-origin destination returned by the session endpoint", async () => {
    const controller = configureSixbSharedBrowserClient(runtimeConfig, {
      grantId: "shr_1",
      fetch: Object.assign(
        async () =>
          Response.json({
            grantId: "shr_1",
            destinationPath: "//outside.example.test/proposal-1",
            expiresAt: "2026-08-29T10:15:00.000Z",
            absoluteExpiresAt: "2026-08-30T10:00:00.000Z",
            csrfToken: "C".repeat(43),
          }),
        { preconnect: fetch.preconnect }
      ),
    })
    controllers.push(controller)

    await expect(controller.getSession()).rejects.toThrow(
      "Shared access session response is invalid"
    )
    expect(controller.getCsrfToken()).toBeNull()
  })

  test.each([
    "/shared/proposal-1",
    "/shared%2Fproposal-1",
    "/shared%5Cproposal-1",
    "/%73hared/proposal-1",
  ])("rejects the framework-owned shared destination %s", async (destinationPath) => {
    const controller = configureSixbSharedBrowserClient(runtimeConfig, {
      grantId: "shr_1",
      fetch: Object.assign(
        async () =>
          Response.json({
            grantId: "shr_1",
            destinationPath,
            expiresAt: "2026-08-29T10:15:00.000Z",
            absoluteExpiresAt: "2026-08-30T10:00:00.000Z",
            csrfToken: "C".repeat(43),
          }),
        { preconnect: fetch.preconnect }
      ),
    })
    controllers.push(controller)

    await expect(controller.getSession()).rejects.toThrow(
      "Shared access session response is invalid"
    )
    expect(controller.getCsrfToken()).toBeNull()
  })
})

describe("browser client auth", () => {
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

  test("owns the activity header: set while visible, removed while hidden", async () => {
    installDocument("visible")
    setSystemTime(new Date("2026-07-01T10:00:00.000Z"))
    configureBrowserClient()
    const visible = await observeSyncRequest({ "x-sixb-session-activity": "wrong" })
    expect(visible.headers.get("x-sixb-session-activity")).toBe("1")

    installDocument("hidden")
    configureBrowserClient()
    const hidden = await observeSyncRequest({ "x-sixb-session-activity": "1" })
    expect(hidden.headers.has("x-sixb-session-activity")).toBe(false)
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

  test("dispose removes activity and expired-session redirect handling and is idempotent", async () => {
    const testDocument = installDocument("visible")
    setSystemTime(new Date("2026-07-01T10:00:00.000Z"))
    const redirects: string[] = []
    const controller = configureBrowserClient({
      getCurrentUrl: () => "http://localhost:3001/devices",
      redirect: (url) => redirects.push(url),
    })

    controller.dispose()
    controller.dispose()
    testDocument.dispatchEvent(new Event("pointerdown"))

    expect((await observeSyncRequest()).headers.has("x-sixb-session-activity")).toBe(false)
    const fetchMock = Object.assign(
      async () => Response.json({ error: "Authentication required" }, { status: 401 }),
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch
    await requestSyncRun({ body: {}, path: { syncId: "sync_1" }, fetch: fetchMock })
    expect(redirects).toEqual([])
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
    expect(redirect.origin).toBe("http://localhost:3002")
    expect(redirect.pathname).toBe("/auth/sign-in")
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

  // Guard proof: drop the activity routes from isAuthRedirectExcludedRequest; a background batch
  // sends the person to sign in.
  test("does not auto-redirect background activity requests", async () => {
    const redirects: string[] = []
    configureBrowserClient({
      getCurrentUrl: () => "http://localhost:3001/devices",
      redirect: (url) => redirects.push(url),
    })
    const fetchMock = Object.assign(
      async () => Response.json({ error: "Authentication required" }, { status: 401 }),
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch

    await getActivityCaptureConfig({ fetch: fetchMock })
    await captureActivity({
      body: { events: [{ id: "e1", type: "page.view", route: "/" }] },
      fetch: fetchMock,
    })
    expect(redirects).toEqual([])

    // Any other request still does.
    await requestSyncRun({ body: {}, path: { syncId: "sync_1" }, fetch: fetchMock })
    expect(redirects).toHaveLength(1)
  })

  // Reproduce: drop the trailing-slash strip in `isAuthRedirectExcludedRequest` (browser.ts); a
  // root base URL then expects `//api/auth/sign-out` and redirects.
  test.each([
    { baseUrl: "http://localhost:3002", path: "/api/auth/sign-out" },
    { baseUrl: "http://localhost:3002/platform", path: "/platform/api/auth/sign-out" },
  ])("does not auto-redirect explicit sign-out requests to $baseUrl", async ({ baseUrl, path }) => {
    const redirects: string[] = []
    const controller = configureBrowserClient(
      {
        getCurrentUrl: () => "http://localhost:3001/devices",
        redirect: (url) => redirects.push(url),
      },
      { ...runtimeConfig, api: { baseUrl } }
    )
    controller.setCsrfToken("csrf_current")
    let requestUrl = ""
    const fetchMock = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        requestUrl = input instanceof Request ? input.url : String(input)
        return Response.json({ error: "Authentication required" }, { status: 401 })
      },
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch

    await signOut({ fetch: fetchMock })

    expect(new URL(requestUrl).pathname).toBe(path)
    expect(controller.getCsrfToken()).toBe("csrf_current")
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
    const fetchMock = Object.assign(
      async () => Response.json({ authenticated: false, authEnabled: true }),
      {
        preconnect: fetch.preconnect,
      }
    ) satisfies typeof fetch
    client.setConfig({ fetch: fetchMock })

    await requireSixbBrowserAuthSession(runtimeConfig, controller, {
      returnTo: "http://localhost:3001/devices",
      redirect: (url) => bootstrapRedirects.push(url),
    })

    expect(controller.getCsrfToken()).toBeNull()
    expect(automaticRedirects).toEqual([])
    expect(bootstrapRedirects).toHaveLength(1)
  })

  test("a shell that assumed auth stops redirecting once the API reports it is off", async () => {
    const automaticRedirects: string[] = []
    const bootstrapRedirects: string[] = []
    const controller = configureBrowserClient({
      getCurrentUrl: () => "http://localhost:3001/devices",
      redirect: (url) => automaticRedirects.push(url),
    })
    client.setConfig({
      fetch: Object.assign(
        async () => Response.json({ authenticated: false, authEnabled: false }),
        {
          preconnect: fetch.preconnect,
        }
      ) satisfies typeof fetch,
    })

    const session = await requireSixbBrowserAuthSession(runtimeConfig, controller, {
      redirect: (url) => bootstrapRedirects.push(url),
    })
    await requestSyncRun({
      body: {},
      path: { syncId: "sync_1" },
      fetch: Object.assign(
        async () => Response.json({ error: "Authentication required" }, { status: 401 }),
        { preconnect: fetch.preconnect }
      ) satisfies typeof fetch,
    })

    expect(session).toEqual({ authenticated: false, authEnabled: false })
    expect(bootstrapRedirects).toEqual([])
    expect(automaticRedirects).toEqual([])
  })
})

// Guard proof: remove preserveSixbActivityArrival() from requireSixbBrowserAuthSession; the
// identity provider replaces the partner that referred the visit.
test("sign-in keeps the arrival, and a later sign-in redirect does not repeat it", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const stored = new Map<string, string>()
  const browser = {
    location: { href: "https://app.example.test/invoices?token=private" },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value)
      },
      removeItem: (key: string) => {
        stored.delete(key)
      },
    },
  }
  const signedOut = Object.assign(async () => Response.json({ authenticated: false }), {
    preconnect: fetch.preconnect,
  }) satisfies typeof fetch
  const config: SixbBrowserRuntimeConfig = {
    api: { baseUrl: "https://api.example.test" },
    auth: { enabled: true },
  }
  const redirects: string[] = []

  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: browser })
    const document = installDocument("visible")
    Object.defineProperty(document, "referrer", {
      configurable: true,
      value: "https://partner.test/private?secret=1",
    })

    const controller = configureBrowserClient({}, config)
    client.setConfig({ fetch: signedOut })
    await requireSixbBrowserAuthSession(config, controller, {
      redirect: (url) => redirects.push(url),
    })
    expect(redirects).toHaveLength(1)
    expect(stored.size).toBe(1)
    expect([...stored.values()].join()).not.toContain("private")
    controller.dispose()

    // Back from the identity provider, the arrival is the partner's, and is consumed.
    Object.defineProperty(document, "referrer", {
      configurable: true,
      value: "https://identity.test/callback",
    })
    const returned = configureBrowserClient({}, config)
    expect(takeActivityArrival()).toEqual({ referrer: "partner.test" })
    expect(stored.size).toBe(0)

    // Capture took the arrival; an expired session's redirect later carries a direct arrival.
    client.setConfig({ fetch: signedOut })
    await requireSixbBrowserAuthSession(config, returned, {
      redirect: (url) => redirects.push(url),
    })
    returned.dispose()
    configureBrowserClient({}, config)
    expect(takeActivityArrival()).toEqual({})
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }
  }
})
