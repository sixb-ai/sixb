import { describe, expect, test } from "bun:test"
import {
  createSixbClient,
  getAuthSession,
  getSixbSessionAccessToken,
  type SixbSessionStore,
  type SixbSessionTokens,
  signOutSixbSession,
  startSixbDeviceLogin,
} from "../src"

const baseUrl = "https://api.example.com"

function memoryStore(initial: SixbSessionTokens | null) {
  let tokens = initial
  const store: SixbSessionStore = {
    load: () => tokens,
    save: (next) => {
      tokens = next
    },
    clear: () => {
      tokens = null
    },
  }
  return { store, current: () => tokens }
}

function tokens(generation: number, expiresInMs: number): SixbSessionTokens {
  return {
    accessToken: `access-${generation}`,
    refreshToken: `refresh-${generation}`,
    accessExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  }
}

/** A fake Sixb API: `/api/auth/refresh` rotates to the next generation; everything else echoes. */
function fakeApi(options: {
  readonly acceptedAccessToken: () => string
  readonly ended?: boolean
}) {
  const calls: string[] = []
  let generation = 1
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    calls.push(`${request.method} ${path} ${request.headers.get("authorization") ?? ""}`.trim())
    if (path === "/api/auth/refresh") {
      if (options.ended) return Response.json({ error: "Invalid refresh token" }, { status: 401 })
      generation += 1
      await Bun.sleep(5)
      return Response.json({
        accessToken: `access-${generation}`,
        refreshToken: `refresh-${generation}`,
        expiresIn: 900,
      })
    }
    if (request.headers.get("authorization") !== `Bearer ${options.acceptedAccessToken()}`) {
      return Response.json({ error: "Authentication required" }, { status: 401 })
    }
    return Response.json({ authenticated: true, body: await request.text() })
  }
  return { fetch: Object.assign(fetch, { preconnect: () => {} }) as typeof globalThis.fetch, calls }
}

describe("native sessions", () => {
  test("signs a device in by polling until the user approves", async () => {
    let polls = 0
    const fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === "/api/auth/device-authorizations") {
        return Response.json({
          deviceCode: "dva_1.secret",
          userCode: "BCDF-HJKM",
          verificationUri: `${baseUrl}/auth/device`,
          verificationUriComplete: `${baseUrl}/auth/device?user_code=BCDF-HJKM`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          interval: 0,
        })
      }
      polls += 1
      return Response.json(
        polls < 2
          ? { status: "pending" }
          : {
              status: "approved",
              accessToken: "access-1",
              refreshToken: "refresh-1",
              expiresIn: 900,
            }
      )
    }) as typeof globalThis.fetch

    const login = await startSixbDeviceLogin({ baseUrl, clientName: "Acme CLI", fetch })
    expect(login.userCode).toBe("BCDF-HJKM")
    await expect(login.complete()).resolves.toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
    })
    expect(polls).toBe(2)
  })

  test("refuses a login page on another origin", async () => {
    const fetch = (async () =>
      Response.json({
        deviceCode: "dva_1.secret",
        userCode: "BCDF-HJKM",
        verificationUri: "https://phish.example/auth/device",
        verificationUriComplete: "https://phish.example/auth/device?user_code=BCDF-HJKM",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        interval: 1,
      })) as unknown as typeof globalThis.fetch
    await expect(startSixbDeviceLogin({ baseUrl, clientName: "x", fetch })).rejects.toThrow(
      "not on the Sixb API origin"
    )
  })

  test("sends the session's token on every request and refreshes once for concurrent callers", async () => {
    const { store, current } = memoryStore(tokens(1, 30_000))
    const api = fakeApi({ acceptedAccessToken: () => current()?.accessToken ?? "" })
    const client = createSixbClient({ baseUrl, fetch: api.fetch, auth: { kind: "session", store } })

    // The access token expires within the refresh margin, so both calls wait on one refresh.
    await Promise.all([getAuthSession({ client }), getAuthSession({ client })])

    expect(api.calls.filter((call) => call.startsWith("POST /api/auth/refresh"))).toHaveLength(1)
    expect(api.calls.filter((call) => call.startsWith("GET /api/auth/session"))).toEqual([
      "GET /api/auth/session Bearer access-2",
      "GET /api/auth/session Bearer access-2",
    ])
    expect(current()?.refreshToken).toBe("refresh-2")
  })

  test("retries a rejected request once with refreshed tokens, body included", async () => {
    const { store, current } = memoryStore(tokens(1, 10 * 60_000))
    // The server already rotated this session elsewhere, so access-1 is rejected before it expires.
    const api = fakeApi({
      acceptedAccessToken: () => (current()?.accessToken === "access-1" ? "" : "access-2"),
    })
    const sessionFetch = createSixbClient({
      baseUrl,
      fetch: api.fetch,
      auth: { kind: "session", store },
    }).getConfig().fetch as typeof globalThis.fetch

    const response = await sessionFetch(`${baseUrl}/api/objects/query`, {
      method: "POST",
      body: JSON.stringify({ objectTypeId: "device" }),
    })

    expect(await response.json()).toEqual({
      authenticated: true,
      body: JSON.stringify({ objectTypeId: "device" }),
    })
    expect(api.calls).toEqual([
      "POST /api/objects/query Bearer access-1",
      "POST /api/auth/refresh",
      "POST /api/objects/query Bearer access-2",
    ])
  })

  test("clears the store and reports once when the session has ended", async () => {
    const { store, current } = memoryStore(tokens(1, 1_000))
    const api = fakeApi({ acceptedAccessToken: () => "never", ended: true })
    let ended = 0
    const client = createSixbClient({
      baseUrl,
      fetch: api.fetch,
      auth: { kind: "session", store, onSessionEnded: () => ended++ },
    })

    const results = await Promise.all([getAuthSession({ client }), getAuthSession({ client })])

    expect(results.map((result) => result.response?.status)).toEqual([401, 401])
    expect(current()).toBeNull()
    expect(ended).toBe(1)
  })

  test("never sends the token to another origin", async () => {
    const { store } = memoryStore(tokens(1, 10 * 60_000))
    const api = fakeApi({ acceptedAccessToken: () => "access-1" })
    const sessionFetch = createSixbClient({
      baseUrl,
      fetch: api.fetch,
      auth: { kind: "session", store },
    }).getConfig().fetch as typeof globalThis.fetch

    await sessionFetch("https://cdn.example.com/file.png")

    expect(api.calls).toEqual(["GET /file.png"])
  })

  test("uses tokens another process already refreshed instead of a rotated refresh token", async () => {
    // Reproduce: refresh with the caller's stale tokens in refreshStoredSession; the API then sees
    // refresh-1 again, which past the server's grace window revokes the session.
    let loads = 0
    const store: SixbSessionStore = {
      load: () => (loads++ === 0 ? tokens(1, 30_000) : tokens(2, 10 * 60_000)),
      save: () => {},
      clear: () => {},
    }
    const api = fakeApi({ acceptedAccessToken: () => "access-2" })

    await expect(getSixbSessionAccessToken({ baseUrl, store, fetch: api.fetch })).resolves.toBe(
      "access-2"
    )
    expect(api.calls).toEqual([])
  })

  test("keeps using a still-valid token when an early refresh cannot reach the API", async () => {
    const { store } = memoryStore(tokens(1, 30_000))
    const offline = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof globalThis.fetch

    await expect(getSixbSessionAccessToken({ baseUrl, store, fetch: offline })).resolves.toBe(
      "access-1"
    )
  })

  test("treats a session the server already ended as signed out", async () => {
    const { store, current } = memoryStore(tokens(1, 10 * 60_000))
    const api = fakeApi({ acceptedAccessToken: () => "revoked" })

    await signOutSixbSession({ baseUrl, store, fetch: api.fetch })

    expect(current()).toBeNull()
  })

  test("signs out on the server, then clears the store", async () => {
    const { store, current } = memoryStore(tokens(1, 10 * 60_000))
    const api = fakeApi({ acceptedAccessToken: () => "access-1" })

    await signOutSixbSession({ baseUrl, store, fetch: api.fetch })

    expect(api.calls).toEqual(["POST /api/auth/sign-out Bearer access-1"])
    expect(current()).toBeNull()
  })
})
