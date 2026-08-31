import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ConnectorOAuthError } from "@sixb/core"
import { TiktokApiError, tiktok } from "../src"

const originalFetch = globalThis.fetch
const signal = new AbortController().signal
const context = { projectId: "demo", connectorId: "tiktok-display", signal }
const authorizationContext = {
  ...context,
  redirectUri: "https://api.example.com/auth/connectors/callback",
}
const authorizationInput = {
  state: "signed-state",
  codeChallenge: "framework-challenge",
  codeChallengeMethod: "S256" as const,
}

beforeEach(() => {
  globalThis.fetch = originalFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("TikTok Display OAuth", () => {
  test("builds the documented Login Kit Web authorization URL", async () => {
    const url = new URL(
      await displayAdapter().authentication.authorizationUrl(
        authorizationContext,
        authorizationInput
      )
    )

    expect(url.origin).toBe("https://www.tiktok.com")
    expect(url.pathname).toBe("/v2/auth/authorize/")
    expect(url.searchParams.get("client_key")).toBe("client-key")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("scope")).toBe(
      "user.info.basic,user.info.profile,user.info.stats,video.list"
    )
    expect(url.searchParams.get("redirect_uri")).toBe(authorizationContext.redirectUri)
    expect(url.searchParams.get("state")).toBe("signed-state")
    expect(url.searchParams.get("disable_auto_auth")).toBe("1")
    expect(url.searchParams.has("code_challenge")).toBeFalse()
  })

  test("exchanges, rotates, and revokes tokens with form-encoded requests", async () => {
    const requests: CapturedRequest[] = []
    mockFetch(async (input, init) => {
      requests.push({ input, init })
      const url = new URL(String(input))
      if (url.pathname.endsWith("/revoke/")) return new Response("")
      const grantType = formBody(init).get("grant_type")
      return json(
        displayToken(
          grantType === "refresh_token" ? "access-2" : "access-1",
          grantType === "refresh_token" ? "refresh-2" : "refresh-1"
        )
      )
    })

    const authentication = displayAdapter().authentication
    const exchanged = await authentication.exchangeCode(authorizationContext, {
      code: "provider-code",
      codeVerifier: "must-not-leave-sixb",
    })
    const refreshed = await authentication.refresh(context, exchanged)
    await authentication.revoke?.(context, refreshed)

    expect(exchanged.accessToken).toBe("access-1")
    expect(exchanged.refreshToken).toBe("refresh-1")
    expect(refreshed.accessToken).toBe("access-2")
    expect(refreshed.refreshToken).toBe("refresh-2")
    expect(exchanged.scopes).toEqual(["user.info.basic", "video.list"])
    expect(new Headers(requests[0]?.init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded"
    )
    expect(Object.fromEntries(formBody(requests[0]?.init))).toEqual({
      client_key: "client-key",
      client_secret: "client-secret",
      code: "provider-code",
      grant_type: "authorization_code",
      redirect_uri: authorizationContext.redirectUri,
    })
    expect(formBody(requests[0]?.init).has("code_verifier")).toBeFalse()
    expect(Object.fromEntries(formBody(requests[1]?.init))).toEqual({
      client_key: "client-key",
      client_secret: "client-secret",
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
    })
    expect(Object.fromEntries(formBody(requests[2]?.init))).toEqual({
      client_key: "client-key",
      client_secret: "client-secret",
      token: "access-2",
    })
  })

  test("classifies provider token errors without hiding their log ID", async () => {
    mockFetch(async () =>
      json(
        {
          error: "invalid_request",
          error_description: "Redirect URI does not match",
          log_id: "log-oauth",
        },
        { status: 400 }
      )
    )

    try {
      await displayAdapter().authentication.exchangeCode(authorizationContext, {
        code: "bad-code",
        codeVerifier: "verifier",
      })
      throw new Error("expected exchange to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorOAuthError)
      expect((error as ConnectorOAuthError).kind).toBe("terminal")
      expect((error as Error).message).toContain("log-oauth")
    }
  })
})

describe("TikTok Display resources", () => {
  test("discovers the authorized user from basic profile fields", async () => {
    let requested = ""
    mockFetch(async (input, init) => {
      requested = String(input)
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer display-token")
      return displayJson({
        user: {
          open_id: "user-1",
          display_name: "Acme Creator",
          avatar_url: "https://cdn.example.com/avatar.jpg",
        },
      })
    })

    const accounts = await displayAdapter().discoverAccounts(context, {
      accessToken: "display-token",
    })

    expect(accounts).toEqual([
      {
        id: "user-1",
        label: "Acme Creator",
        description: undefined,
        avatarUrl: "https://cdn.example.com/avatar.jpg",
      },
    ])
    expect(new URL(requested).searchParams.get("fields")).toBe("open_id,display_name,avatar_url")
  })

  test("reads profile statistics and paginates public videos", async () => {
    const requests: CapturedRequest[] = []
    mockFetch(async (input, init) => {
      requests.push({ input, init })
      const url = new URL(String(input))
      if (url.pathname.endsWith("/user/info/")) {
        return displayJson({ user: { open_id: "user-1", follower_count: 42 } })
      }
      const cursor = jsonBody(init).cursor
      return displayJson(
        cursor
          ? { videos: [{ id: "video-2", view_count: 20 }], cursor: 200, has_more: false }
          : { videos: [{ id: "video-1", view_count: 10 }], cursor: 100, has_more: true },
        `log-${cursor ?? "first"}`
      )
    })

    const client = await displayClient()
    const profile = await client.profile.get({ fields: ["open_id", "follower_count"] })
    const videos = await collect(
      client.videos.listAll({ fields: ["id", "view_count"], maxCount: 20 })
    )

    expect(profile.follower_count).toBe(42)
    expect(videos.map((video) => video.id)).toEqual(["video-1", "video-2"])
    expect(new URL(String(requests[0]?.input)).searchParams.get("fields")).toBe(
      "open_id,follower_count"
    )
    expect(new URL(String(requests[1]?.input)).searchParams.get("fields")).toBe("id,view_count")
    expect(jsonBody(requests[1]?.init)).toEqual({ max_count: 20 })
    expect(jsonBody(requests[2]?.init)).toEqual({ cursor: 100, max_count: 20 })
  })

  test("queries up to 20 owned videos by ID", async () => {
    let request: CapturedRequest | undefined
    mockFetch(async (input, init) => {
      request = { input, init }
      return displayJson({ videos: [{ id: "video-1", comment_count: 3 }] })
    })

    const videos = await (await displayClient()).videos.query({
      videoIds: ["video-1"],
      fields: ["id", "comment_count"],
    })

    expect(videos[0]?.comment_count).toBe(3)
    expect(new URL(String(request?.input)).pathname).toEndWith("/video/query/")
    expect(new URL(String(request?.input)).searchParams.get("fields")).toBe("id,comment_count")
    expect(jsonBody(request?.init)).toEqual({ filters: { video_ids: ["video-1"] } })
  })

  test("preserves Display API envelope failures", async () => {
    mockFetch(async () =>
      json({
        data: {},
        error: { code: "scope_not_authorized", message: "Missing scope", log_id: "log-api" },
      })
    )

    try {
      await (await displayClient()).profile.get()
      throw new Error("expected request to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(TiktokApiError)
      expect((error as TiktokApiError).code).toBe("scope_not_authorized")
      expect((error as TiktokApiError).requestId).toBe("log-api")
    }
  })
})

function displayAdapter() {
  return tiktok({
    api: "display",
    clientKey: "client-key",
    clientSecret: "client-secret",
    scopes: ["user.info.basic", "user.info.profile", "user.info.stats", "video.list"],
    disableAutoAuth: true,
    baseUrl: "https://open-api.example.com/v2/",
    retry: { maxRetries: 0 },
  })
}

async function displayClient() {
  return displayAdapter().connect({
    ...context,
    connectionId: "connection-1",
    account: { id: "user-1", label: "Acme Creator" },
    tokenSource: staticToken("display-token"),
  })
}

function staticToken(accessToken: string) {
  return {
    async get() {
      return { accessToken, invalidate() {} }
    },
  }
}

function displayToken(accessToken: string, refreshToken: string) {
  return {
    access_token: accessToken,
    expires_in: 86_400,
    open_id: "user-1",
    refresh_expires_in: 31_536_000,
    refresh_token: refreshToken,
    scope: "user.info.basic,video.list",
    token_type: "Bearer",
  }
}

type CapturedRequest = {
  readonly input: RequestInfo | URL
  readonly init?: RequestInit
}

function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = implementation as typeof fetch
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
}

function displayJson(data: unknown, logId = "log-api"): Response {
  return json({ data, error: { code: "ok", message: "", log_id: logId } })
}

function formBody(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body))
}

function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) items.push(item)
  return items
}
