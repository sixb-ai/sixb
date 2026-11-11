import { afterEach, describe, expect, test } from "bun:test"
import {
  type ConnectorAccessToken,
  ConnectorOAuthError,
  type ConnectorTokenSource,
} from "@sixb/core"
import { type MetaInstagramOAuthConnectorOptions, meta } from "../src"

const originalFetch = globalThis.fetch
const context = {
  projectId: "test",
  connectorId: "meta-instagram",
  signal: new AbortController().signal,
}
const redirectUri = "https://api.example/auth/connectors/callback"
const options = {
  appId: "instagram-app-id",
  appSecret: "instagram-app-secret",
  accounts: "instagram",
  login: "instagram",
} as const satisfies MetaInstagramOAuthConnectorOptions
const SIXTY_DAYS = 5_184_000

interface Call {
  readonly url: URL
  readonly method: string
  readonly headers: Headers
  readonly form: URLSearchParams
}

const calls: Call[] = []

function route(respond: (call: Call) => Response | Promise<Response>): void {
  calls.length = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      form: new URLSearchParams(init?.body instanceof URLSearchParams ? init.body : undefined),
    }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Instagram's sign-in calls: the code exchange, the long-lived exchange and the account. */
function fakeInstagram(): void {
  route((call) => {
    switch (`${call.url.host}${call.url.pathname}`) {
      case "api.instagram.com/oauth/access_token":
        return json({
          data: [
            {
              access_token: "short-token",
              user_id: "app-scoped-1",
              // What Instagram sends, although its docs show a comma-separated string.
              permissions: ["instagram_business_basic", "instagram_business_content_publish"],
            },
          ],
        })
      case "graph.instagram.com/access_token":
        return json({ access_token: "long-token", token_type: "bearer", expires_in: SIXTY_DAYS })
      case "graph.instagram.com/v23.0/me":
        return json({ id: "app-scoped-1", user_id: "ig-1", username: "bakery" })
      default:
        return json({ error: { message: `Unexpected ${call.url.href}`, code: 100 } }, 400)
    }
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("Instagram API with Instagram Login", () => {
  test("signs in on instagram.com with the Instagram app and its permissions", async () => {
    const url = new URL(
      await meta(options).authentication.authorizationUrl({ ...context, redirectUri }, {
        state: "state-1",
      } as never)
    )
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "instagram-app-id",
      redirect_uri: redirectUri,
      response_type: "code",
      scope:
        "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights",
      state: "state-1",
    })
  })

  test("asks for credentials on every sign-in when reauthenticate is set", async () => {
    const url = new URL(
      await meta({ ...options, reauthenticate: true }).authentication.authorizationUrl(
        { ...context, redirectUri },
        { state: "state-1" } as never
      )
    )
    expect(url.searchParams.get("force_reauth")).toBe("true")
  })

  test("keeps a 60-day token for the account that signed in", async () => {
    fakeInstagram()
    const before = Date.now()
    const credentials = await meta(options).authentication.exchangeCode(
      { ...context, redirectUri },
      { code: "code-1#_" } as never
    )
    const { expiresAt, ...rest } = credentials
    expect(rest).toEqual({
      accessToken: "long-token",
      refreshToken: "long-token",
      tokenType: "Bearer",
      scopes: ["instagram_business_basic", "instagram_business_content_publish"],
      authorizationContext: { instagramAccounts: { "ig-1": { username: "bakery" } } },
    })
    // Refreshed at half its life, so 30 days of syncs remain to do it.
    expect(expiresAt!.getTime()).toBeGreaterThanOrEqual(before + (SIXTY_DAYS * 1000) / 2)
    expect(expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + (SIXTY_DAYS * 1000) / 2)

    const [code, exchange, me] = calls
    expect(code!.method).toBe("POST")
    expect(Object.fromEntries(code!.form)).toEqual({
      client_id: "instagram-app-id",
      client_secret: "instagram-app-secret",
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code: "code-1",
    })
    // Instagram refuses a POST here ("Unsupported request - method type: post").
    expect(exchange!.method).toBe("GET")
    expect(Object.fromEntries(exchange!.url.searchParams)).toEqual({
      grant_type: "ig_exchange_token",
      client_secret: "instagram-app-secret",
      access_token: "short-token",
    })
    expect(me!.headers.get("authorization")).toBe("Bearer long-token")
    expect([code, me].every((call) => !/secret|token/.test(call!.url.search))).toBe(true)

    expect(meta(options).discoverAccounts(context, credentials)).toEqual([
      { id: "ig-1", label: "@bakery", description: "Instagram professional account" },
    ])
  })

  test("refreshes the long-lived token with itself", async () => {
    route(() => json({ access_token: "new-token", token_type: "bearer", expires_in: SIXTY_DAYS }))
    const refreshed = await meta(options).authentication.refresh(context, {
      accessToken: "long-token",
      refreshToken: "long-token",
    })
    expect(refreshed).toMatchObject({
      accessToken: "new-token",
      refreshToken: "new-token",
      tokenType: "Bearer",
    })
    const [call] = calls
    expect(call!.url.href).toBe(
      "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token"
    )
    expect(call!.headers.get("authorization")).toBe("Bearer long-token")
  })

  test("says what Instagram refused", async () => {
    route(() =>
      json({ error_type: "OAuthException", code: 400, error_message: "Invalid platform app" }, 400)
    )
    const error = await Promise.resolve(
      meta(options).authentication.exchangeCode({ ...context, redirectUri }, {
        code: "c",
      } as never)
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ConnectorOAuthError)
    expect((error as ConnectorOAuthError).message).toBe(
      "[SixbMeta] Instagram rejected the code exchange (400): Invalid platform app."
    )
  })

  test("reads and publishes through graph.instagram.com, without Pages", async () => {
    route((call) =>
      call.url.pathname === "/v23.0/ig-1"
        ? json({ id: "ig-1", username: "bakery", name: "Bakery" })
        : json({ id: "container-1" })
    )
    const source: ConnectorTokenSource = {
      async get(): Promise<ConnectorAccessToken> {
        return { accessToken: "long-token", tokenType: "Bearer", invalidate: () => undefined }
      },
    }
    const client = await meta(options).connect({
      ...context,
      connectionId: "connection-1",
      account: { id: "ig-1", label: "@bakery" },
      tokenSource: source,
    })
    expect(client.account).toEqual({
      instagramAccountId: "ig-1",
      username: "bakery",
      name: "Bakery",
    })
    expect("pages" in client || "facebook" in client).toBe(false)

    await client.instagram("ig-1").media.create({ image_url: "https://cdn.example/a.jpg" })
    const create = calls.at(-1)!
    expect(create.url.href).toBe("https://graph.instagram.com/v23.0/ig-1/media")
    expect(create.headers.get("authorization")).toBe("Bearer long-token")
  })
})

describe("Instagram Login batches", () => {
  test("sends a batch's reads one by one, in order, since graph.instagram.com has no batch", async () => {
    route((call) => {
      if (call.url.pathname === "/v23.0/ig-1") return json({ id: "ig-1", username: "bakery" })
      return call.url.pathname.endsWith("/ig-1/insights")
        ? json({ data: [{ name: "views" }] })
        : json({ error: { message: "Unsupported get request", code: 100 } }, 400)
    })
    const source: ConnectorTokenSource = {
      async get(): Promise<ConnectorAccessToken> {
        return { accessToken: "long-token", tokenType: "Bearer", invalidate: () => undefined }
      },
    }
    const client = await meta({ ...options, retry: { maxRetries: 0 } }).connect({
      ...context,
      connectionId: "connection-1",
      account: { id: "ig-1", label: "@bakery" },
      tokenSource: source,
    })
    calls.length = 0
    const [insights, missing] = await client.batch.execute([
      client.batch.get("ig-1/insights?metric=views"),
      client.batch.get("ig-2/insights?metric=views"),
    ])
    expect(insights).toMatchObject({ ok: true, status: 200, body: { data: [{ name: "views" }] } })
    expect(missing).toMatchObject({ ok: false, status: 400, error: { code: 100 } })
    expect(calls.map((call) => `${call.method} ${call.url.href}`)).toEqual([
      "GET https://graph.instagram.com/v23.0/ig-1/insights?metric=views",
      "GET https://graph.instagram.com/v23.0/ig-2/insights?metric=views",
    ])
    expect(calls.every((call) => call.headers.get("authorization") === "Bearer long-token")).toBe(
      true
    )
  })
})
