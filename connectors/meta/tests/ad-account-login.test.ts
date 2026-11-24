import { afterEach, describe, expect, test } from "bun:test"
import {
  type ConnectorAccessToken,
  type ConnectorOAuthCredentials,
  ConnectorOAuthError,
  type ConnectorTokenSource,
} from "@sixb/core"
import { type MetaAdAccountOAuthConnectorOptions, meta } from "../src"

const originalFetch = globalThis.fetch
const context = { projectId: "test", connectorId: "meta-ads", signal: new AbortController().signal }
const redirectUri = "https://api.example/auth/connectors/callback"
const options = {
  appId: "app-id",
  appSecret: "app-secret",
  configId: "config-id",
  accounts: "ads",
} as const satisfies MetaAdAccountOAuthConnectorOptions
const SIXTY_DAYS = 5_183_944

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
      form: new URLSearchParams(
        init?.body instanceof URLSearchParams || typeof init?.body === "string"
          ? init.body
          : undefined
      ),
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

const grant = {
  accessToken: "user-token",
  tokenType: "Bearer",
  authorizationContext: {
    userId: "user-1",
    adAccounts: {
      "111": { name: "Brewery", businessName: "Brewery Group", currency: "USD" },
      "222": { name: "Side project", timeZone: "Europe/Paris" },
    },
  },
} satisfies ConnectorOAuthCredentials

/** Answers the sign-in calls: token exchanges, the user, its permissions and its ad accounts. */
function fakeGraph(adAccounts: readonly (readonly Record<string, unknown>[])[]): void {
  route((call) => {
    switch (call.url.pathname) {
      case "/v23.0/oauth/access_token":
        return call.form.has("code")
          ? json({ access_token: "short-token", token_type: "bearer", expires_in: 3600 })
          : json({ access_token: "user-token", token_type: "bearer", expires_in: SIXTY_DAYS })
      case "/v23.0/me":
        return json({ id: "user-1" })
      case "/v23.0/me/permissions":
        return json({
          data: [
            { permission: "ads_management", status: "granted" },
            { permission: "leads_retrieval", status: "granted" },
            { permission: "business_management", status: "declined" },
          ],
        })
    }
    const index = call.url.searchParams.has("after") ? 1 : 0
    const hasNext = index + 1 < adAccounts.length
    return json({
      data: adAccounts[index] ?? [],
      ...(hasNext
        ? { paging: { cursors: { after: "cursor-1" }, next: "https://graph.facebook.com/next" } }
        : {}),
    })
  })
}

async function oauthRejection(run: () => unknown): Promise<ConnectorOAuthError> {
  const error = await Promise.resolve()
    .then(run)
    .then(
      () => undefined,
      (caught: unknown) => caught
    )
  if (!(error instanceof ConnectorOAuthError)) {
    throw new Error(`Expected a ConnectorOAuthError, got ${String(error)}`)
  }
  return error
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("Meta ad accounts with Facebook Login", () => {
  test("signs in through the Facebook Login for Business dialog", async () => {
    const url = new URL(
      String(
        await meta(options).authentication.authorizationUrl(
          { ...context, redirectUri },
          { state: "state-1" }
        )
      )
    )
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth")
    expect(url.searchParams.get("config_id")).toBe("config-id")
  })

  test.each([
    [{ appId: "app-id", appSecret: "app-secret", accounts: "ads" }, "exactly one of configId"],
    [{ ...options, scopes: ["ads_read"] }, "exactly one of configId"],
    [{ ...options, login: "instagram" }, "login is not supported"],
  ])("rejects invalid login options %#", (invalid, message) => {
    expect(() => meta(invalid as MetaAdAccountOAuthConnectorOptions)).toThrow(message)
  })

  test("refuses Instagram Login at the type level", () => {
    // @ts-expect-error Instagram Login connects Instagram accounts, not ad accounts.
    expect(() => meta({ ...options, login: "instagram" })).toThrow("login is not supported")
  })

  test("keeps the ~60-day user token with every granted ad account", async () => {
    fakeGraph([
      [
        {
          id: "act_111",
          account_id: "111",
          name: "Brewery",
          currency: "USD",
          business: { id: "b-1", name: "Brewery Group" },
        },
        { id: "act_not-a-number" },
      ],
      [{ id: "act_222", name: "Side project", timezone_name: "Europe/Paris" }],
    ])
    const before = Date.now()
    const credentials = await meta(options).authentication.exchangeCode(
      { ...context, redirectUri },
      { code: "code-1" }
    )

    const { expiresAt, ...rest } = credentials
    expect(rest).toEqual({ ...grant, scopes: ["ads_management", "leads_retrieval"] })
    // The long-lived token's life, not the short-lived one's: Sixb asks to reconnect in time.
    expect(expiresAt!.getTime()).toBeGreaterThanOrEqual(before + SIXTY_DAYS * 1000)
    expect(expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + SIXTY_DAYS * 1000)

    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /v23.0/oauth/access_token",
      "POST /v23.0/oauth/access_token",
      "GET /v23.0/me",
      "GET /v23.0/me/permissions",
      "GET /v23.0/me/adaccounts",
      "GET /v23.0/me/adaccounts",
    ])
    expect(calls[1]!.form.get("fb_exchange_token")).toBe("short-token")
    expect(calls[4]!.headers.get("authorization")).toBe("Bearer user-token")
    expect(calls[4]!.url.searchParams.get("fields")).toBe(
      "id,account_id,name,currency,timezone_name,business{name}"
    )
    expect(calls[5]!.url.searchParams.get("after")).toBe("cursor-1")
    for (const secret of ["app-secret", "code-1", "short-token", "user-token"]) {
      expect(calls.map((call) => call.url.href).join(" ")).not.toContain(secret)
    }
  })

  test("refuses a sign-in that grants no ad account", async () => {
    fakeGraph([[]])
    const error = await oauthRejection(() =>
      meta(options).authentication.exchangeCode({ ...context, redirectUri }, { code: "code-1" })
    )
    expect(error.kind).toBe("terminal")
    expect(error.message).toContain("tick at least one ad account")
  })

  test("keeps the ad accounts of a grant refused their business portfolio", async () => {
    route((call) => {
      if (call.url.pathname === "/v23.0/oauth/access_token") {
        return json({ access_token: "user-token", expires_in: SIXTY_DAYS })
      }
      if (call.url.pathname === "/v23.0/me") return json({ id: "user-1" })
      if (call.url.pathname === "/v23.0/me/permissions") return json({ data: [] })
      if (call.url.searchParams.get("fields")?.includes("business")) {
        return json({ error: { message: "Missing permission", code: 200 } }, 403)
      }
      return json({ data: [{ id: "act_111", account_id: "111", name: "Brewery" }] })
    })
    const credentials = await meta(options).authentication.exchangeCode(
      { ...context, redirectUri },
      { code: "code-1" }
    )
    expect(credentials.authorizationContext).toEqual({
      userId: "user-1",
      adAccounts: { "111": { name: "Brewery" } },
    })
    expect(calls.filter((call) => call.url.pathname === "/v23.0/me/adaccounts")).toHaveLength(2)
  })

  test("does not mistake an outage for a refused business field", async () => {
    route((call) => {
      if (call.url.pathname === "/v23.0/oauth/access_token") {
        return json({ access_token: "user-token", expires_in: SIXTY_DAYS })
      }
      if (call.url.pathname === "/v23.0/me") return json({ id: "user-1" })
      if (call.url.pathname === "/v23.0/me/permissions") return json({ data: [] })
      return json({ error: { message: "Service unavailable", code: 2 } }, 503)
    })
    const error = await oauthRejection(() =>
      meta(options).authentication.exchangeCode({ ...context, redirectUri }, { code: "code-1" })
    )
    expect(error.kind).toBe("retryable")
    expect(calls.filter((call) => call.url.pathname === "/v23.0/me/adaccounts")).toHaveLength(1)
  })

  test("lists granted ad accounts and hands each the user token", async () => {
    const connector = meta(options)
    expect(await connector.discoverAccounts(context, grant)).toEqual([
      { id: "111", label: "Brewery", description: "Ad account 111 · Brewery Group" },
      { id: "222", label: "Side project", description: "Ad account 222" },
    ])
    expect(
      connector.authentication.accountAccessToken?.(grant, { id: "222", label: "Side project" })
    ).toEqual({ accessToken: "user-token", tokenType: "Bearer" })
    expect(() =>
      connector.authentication.accountAccessToken?.(grant, { id: "333", label: "Gone" })
    ).toThrow("does not include ad account 333")
  })

  test("never refreshes: Facebook issues no refresh token", async () => {
    const error = await oauthRejection(() => meta(options).authentication.refresh(context, grant))
    expect(error.kind).toBe("terminal")
  })

  test("revokes as the app, and treats a user already gone as revoked", async () => {
    route(() => json({ success: true }))
    await meta(options).authentication.revoke?.(context, grant)
    expect(calls[0]!.method).toBe("DELETE")
    expect(calls[0]!.url.pathname).toBe("/v23.0/user-1/permissions")
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer app-id|app-secret")

    route(() => json({ error: { message: "Unsupported delete request", code: 100 } }, 400))
    await meta(options).authentication.revoke?.(context, grant)
  })
})

describe("Meta ad account client", () => {
  const source: ConnectorTokenSource = {
    async get(): Promise<ConnectorAccessToken> {
      return { accessToken: "user-token", tokenType: "Bearer", invalidate: () => undefined }
    },
  }

  test("reads the connected ad account and its leads with the user token", async () => {
    route((call) => {
      if (call.url.pathname === "/v23.0/act_111") {
        return json({
          id: "act_111",
          name: "Brewery",
          currency: "USD",
          timezone_name: "America/New_York",
          business: { id: "b-1", name: "Brewery Group" },
        })
      }
      if (call.url.pathname === "/v23.0/") {
        return json([{ code: 200, body: JSON.stringify({ data: [{ id: "lead-1" }] }) }])
      }
      return json({ data: [] })
    })
    const client = await meta(options).connect({
      ...context,
      connectionId: "connection-1",
      account: { id: "111", label: "Brewery" },
      tokenSource: source,
    })

    expect(client.account).toEqual({
      adAccountId: "111",
      name: "Brewery",
      businessName: "Brewery Group",
      currency: "USD",
      timeZone: "America/New_York",
    })
    expect(Object.keys(client).sort()).toEqual(["account", "ads", "batch"])
    expect(Object.keys(client.ads)).toEqual(["account"])

    await client.ads.account(client.account.adAccountId).campaigns.list()
    const [leads] = await client.batch.execute([client.batch.get("ad-1/leads?fields=id")])
    expect(leads).toMatchObject({ ok: true, body: { data: [{ id: "lead-1" }] } })

    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "GET /v23.0/act_111",
      "GET /v23.0/act_111/campaigns",
      "POST /v23.0/",
    ])
    expect(calls.every((call) => call.headers.get("authorization") === "Bearer user-token")).toBe(
      true
    )
  })

  test("reads the account without its business when the token is refused that field", async () => {
    route((call) =>
      call.url.searchParams.get("fields")?.includes("business")
        ? json({ error: { message: "Missing permission", code: 200 } }, 403)
        : json({ id: "act_111", name: "Brewery", currency: "USD" })
    )
    const client = await meta(options).connect({
      ...context,
      connectionId: "connection-1",
      account: { id: "111", label: "Brewery" },
      tokenSource: source,
    })
    expect(client.account).toEqual({ adAccountId: "111", name: "Brewery", currency: "USD" })
  })

  test("falls back to the account label when Meta returns no name", async () => {
    route(() => json({ id: "act_222" }))
    const client = await meta(options).connect({
      ...context,
      connectionId: "connection-2",
      account: { id: "222", label: "Side project" },
      tokenSource: source,
    })
    expect(client.account).toEqual({ adAccountId: "222", name: "Side project" })
  })
})
