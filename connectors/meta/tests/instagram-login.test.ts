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
  appId: "app-id",
  appSecret: "app-secret",
  configId: "unified-config",
  accounts: "instagram",
} as const satisfies MetaInstagramOAuthConnectorOptions

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

/** The Unified Login calls: the code exchange, the system user and the shared accounts. */
function fakeGraph(input: {
  readonly exchange?: Record<string, unknown>
  readonly accounts: readonly (readonly Record<string, unknown>[])[]
}): void {
  route((call) => {
    switch (call.url.pathname) {
      case "/v23.0/oauth/access_token":
        return json(input.exchange ?? { access_token: "system-token", token_type: "bearer" })
      case "/v23.0/me":
        return json({ id: "system-user-1", client_business_id: "business-1" })
      case "/v23.0/me/assigned_instagram_accounts": {
        const page = Number(call.url.searchParams.get("after") ?? 0)
        const next = page + 1 < input.accounts.length ? String(page + 1) : null
        return json({
          data: input.accounts[page] ?? [],
          ...(next
            ? {
                paging: {
                  cursors: { after: next },
                  next: `https://graph.facebook.com/next/${next}`,
                },
              }
            : {}),
        })
      }
      default:
        return json({ error: { message: `Unexpected ${call.url.pathname}`, code: 100 } }, 400)
    }
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("Instagram API with Unified Login", () => {
  test("logs in with the Unified Login configuration and the Meta app", async () => {
    const url = new URL(
      await meta(options).authentication.authorizationUrl({ ...context, redirectUri }, {
        state: "state-1",
      } as never)
    )
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "app-id",
      redirect_uri: redirectUri,
      state: "state-1",
      response_type: "code",
      config_id: "unified-config",
    })
  })

  test("exchanges the code once and lists every shared Instagram account, across pages", async () => {
    fakeGraph({
      accounts: [[{ id: "ig-1", username: "bakery" }], [{ id: "ig-2" }]],
    })
    const credentials = await meta(options).authentication.exchangeCode(
      { ...context, redirectUri },
      { code: "code-1" } as never
    )
    expect(credentials).toEqual({
      accessToken: "system-token",
      tokenType: "Bearer",
      authorizationContext: {
        systemUserId: "system-user-1",
        clientBusinessId: "business-1",
        instagramAccounts: { "ig-1": { username: "bakery" }, "ig-2": {} },
      },
    })
    const exchange = calls[0]!
    expect(exchange.method).toBe("POST")
    expect(Object.fromEntries(exchange.form)).toEqual({
      client_id: "app-id",
      client_secret: "app-secret",
      redirect_uri: redirectUri,
      code: "code-1",
    })
    // A system user token: no long-lived exchange, and the secret never travels in a URL.
    expect(calls.some((call) => call.form.get("grant_type") === "fb_exchange_token")).toBe(false)
    expect(calls.every((call) => !call.url.search.includes("app-secret"))).toBe(true)
    expect(
      calls.slice(1).every((call) => call.headers.get("authorization") === "Bearer system-token")
    ).toBe(true)

    expect(meta(options).discoverAccounts(context, credentials)).toEqual([
      { id: "ig-1", label: "@bakery", description: "Instagram professional account" },
      { id: "ig-2", label: "ig-2", description: "Instagram professional account" },
    ])
  })

  test("connects when the configuration does not allow reading the client's business", async () => {
    fakeGraph({ accounts: [[{ id: "ig-1" }]] })
    const answer = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (
        url.pathname === "/v23.0/me" &&
        url.searchParams.get("fields")?.includes("client_business_id")
      ) {
        return json(
          { error: { message: "(#100) Tried accessing nonexisting field", code: 100 } },
          400
        )
      }
      if (url.pathname === "/v23.0/me") return json({ id: "system-user-1" })
      return answer(input, init)
    }) as typeof fetch
    const credentials = await meta(options).authentication.exchangeCode(
      { ...context, redirectUri },
      { code: "c" } as never
    )
    expect(credentials.authorizationContext).toEqual({
      systemUserId: "system-user-1",
      instagramAccounts: { "ig-1": {} },
    })
  })

  test("keeps the configuration's expiry, so Sixb asks to reconnect in time", async () => {
    fakeGraph({
      exchange: { access_token: "system-token", expires_in: 5_184_000 },
      accounts: [[{ id: "ig-1" }]],
    })
    const before = Date.now()
    const credentials = await meta(options).authentication.exchangeCode(
      { ...context, redirectUri },
      { code: "c" } as never
    )
    const expiresAt = credentials.expiresAt!.getTime()
    expect(expiresAt).toBeGreaterThanOrEqual(before + 5_184_000_000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 5_184_000_000)
  })

  test("refuses a login that shared no Instagram account, and never refreshes on its own", async () => {
    fakeGraph({ accounts: [[]] })
    const auth = meta(options).authentication
    const error = await Promise.resolve(
      auth.exchangeCode({ ...context, redirectUri }, { code: "c" } as never)
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ConnectorOAuthError)
    expect((error as ConnectorOAuthError).message).toContain("no Instagram account")
    expect(() => auth.refresh(context, { accessToken: "system-token" })).toThrow("connect again")
    expect(auth.revoke).toBeUndefined()
  })

  test("connects one account with the grant's token, without Pages", async () => {
    route((call) =>
      call.url.pathname === "/v23.0/ig-1"
        ? json({ id: "ig-1", username: "bakery", name: "Bakery" })
        : json({ id: "container-1" })
    )
    const source: ConnectorTokenSource = {
      async get(): Promise<ConnectorAccessToken> {
        return { accessToken: "system-token", tokenType: "Bearer", invalidate: () => undefined }
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
    expect(create.url.href).toBe("https://graph.facebook.com/v23.0/ig-1/media")
    expect(create.headers.get("authorization")).toBe("Bearer system-token")
  })
})
