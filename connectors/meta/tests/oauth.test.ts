import { afterEach, describe, expect, test } from "bun:test"
import {
  type ConnectorAccessToken,
  type ConnectorOAuthCredentials,
  ConnectorOAuthError,
  type ConnectorTokenSource,
} from "@sixb/core"
import { MetaApiError, type MetaOAuthConnectorOptions, meta } from "../src"

const originalFetch = globalThis.fetch
const context = { projectId: "test", connectorId: "meta", signal: new AbortController().signal }
const redirectUri = "https://api.example/auth/connectors/callback"
const options = {
  appId: "app-id",
  appSecret: "app-secret",
  configId: "config-id",
} as const satisfies MetaOAuthConnectorOptions

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

const invalidToken = () =>
  json(
    { error: { message: "Error validating access token", type: "OAuthException", code: 190 } },
    400
  )

const grant = {
  accessToken: "user-token",
  tokenType: "Bearer",
  authorizationContext: {
    userId: "user-1",
    pages: {
      "page-1": { accessToken: "page-token-1", name: "Bakery", instagramUsername: "bakery" },
      "page-2": { accessToken: "page-token-2", name: "Florist" },
    },
  },
} satisfies ConnectorOAuthCredentials

/** Answers the sign-in calls: token exchanges, the user, its permissions and its Pages. */
function fakeGraph(input: {
  readonly permissions?: readonly string[]
  readonly pages: readonly (readonly Record<string, unknown>[])[]
}): void {
  const permissions = input.permissions ?? [
    "pages_show_list",
    "pages_manage_posts",
    "instagram_basic",
  ]
  route((call) => {
    switch (call.url.pathname) {
      case "/v23.0/oauth/access_token":
        return json({
          access_token: call.form.has("code") ? "short-token" : "user-token",
          token_type: "bearer",
          expires_in: 5_183_944,
        })
      case "/v23.0/me":
        return json({ id: "user-1" })
      case "/v23.0/me/permissions":
        return json({
          data: [
            ...permissions.map((permission) => ({ permission, status: "granted" })),
            { permission: "read_insights", status: "declined" },
          ],
        })
    }
    const index = call.url.searchParams.has("after") ? 1 : 0
    const hasNext = index + 1 < input.pages.length
    return json({
      data: input.pages[index] ?? [],
      ...(hasNext
        ? { paging: { cursors: { after: "cursor-1" }, next: "https://graph.facebook.com/next" } }
        : {}),
    })
  })
}

/** Mirrors Sixb for a grant without a refresh token: a rejected token fails every later read. */
function tokenSource(accessToken = "page-token-1") {
  const state = { invalidated: 0, reauthorized: false }
  const source: ConnectorTokenSource = {
    async get(): Promise<ConnectorAccessToken> {
      if (state.invalidated > 0 && !state.reauthorized) {
        throw new Error("[Sixb] Connector credentials require reauthorization.")
      }
      return { accessToken, tokenType: "Bearer", invalidate: () => state.invalidated++ }
    },
  }
  return { source, state }
}

function connect(source: ConnectorTokenSource) {
  return meta(options).connect({
    ...context,
    connectionId: "connection-1",
    account: { id: "page-1", label: "Bakery" },
    tokenSource: source,
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

describe("Meta OAuth authorization", () => {
  test("sends users to the versioned Facebook Login for Business dialog", async () => {
    const url = new URL(
      String(
        await meta(options).authentication.authorizationUrl(
          { ...context, redirectUri },
          { state: "state-1" }
        )
      )
    )
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "app-id",
      redirect_uri: redirectUri,
      state: "state-1",
      response_type: "code",
      config_id: "config-id",
    })
    expect(meta(options).authentication.pkce).toBe("disabled")
  })

  test("passes Facebook Login permissions as one comma-separated scope", async () => {
    const connector = meta({
      appId: "app-id",
      appSecret: "app-secret",
      scopes: ["pages_show_list", "pages_manage_posts", "pages_show_list"],
    })
    const url = new URL(
      String(
        await connector.authentication.authorizationUrl(
          { ...context, redirectUri },
          { state: "state-1" }
        )
      )
    )
    expect(url.searchParams.get("scope")).toBe("pages_show_list,pages_manage_posts")
    expect(url.searchParams.has("config_id")).toBe(false)
  })

  test.each([
    [{ appId: "app-id", appSecret: "app-secret" }, "exactly one of configId or scopes"],
    [{ ...options, scopes: ["pages_show_list"] }, "exactly one of configId or scopes"],
    [{ appId: "app-id", appSecret: "app-secret", scopes: [] }, "at least one permission"],
    [{ appId: "app-id", appSecret: "app-secret", scopes: ["a b"] }, "single permission"],
    [{ ...options, appSecret: " " }, "appSecret must not be empty"],
    [{ ...options, configId: "" }, "configId must not be empty"],
  ])("rejects invalid login options %#", (invalid, message) => {
    expect(() => meta(invalid as MetaOAuthConnectorOptions)).toThrow(message)
  })

  test("exchanges the code for a long-lived grant holding every granted Page token", async () => {
    fakeGraph({
      // Two result pages, to prove the cursor is followed.
      pages: [
        [
          {
            id: "page-1",
            name: "Bakery",
            access_token: "page-token-1",
            instagram_business_account: { id: "ig-1", username: "bakery" },
          },
          { id: "no-task", name: "Read only" },
        ],
        [{ id: "page-2", name: "Florist", access_token: "page-token-2" }],
      ],
    })

    const credentials = await meta(options).authentication.exchangeCode(
      { ...context, redirectUri },
      { code: "code-1" }
    )

    expect(credentials).toEqual({
      ...grant,
      scopes: ["pages_show_list", "pages_manage_posts", "instagram_basic"],
    })
    expect(credentials).not.toHaveProperty("expiresAt")

    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /v23.0/oauth/access_token",
      "POST /v23.0/oauth/access_token",
      "GET /v23.0/me",
      "GET /v23.0/me/permissions",
      "GET /v23.0/me/accounts",
      "GET /v23.0/me/accounts",
    ])
    expect(Object.fromEntries(calls[0]!.form)).toEqual({
      client_id: "app-id",
      client_secret: "app-secret",
      redirect_uri: redirectUri,
      code: "code-1",
    })
    expect(Object.fromEntries(calls[1]!.form)).toEqual({
      grant_type: "fb_exchange_token",
      client_id: "app-id",
      client_secret: "app-secret",
      fb_exchange_token: "short-token",
    })
    expect(calls[4]!.headers.get("authorization")).toBe("Bearer user-token")
    expect(calls[4]!.url.searchParams.get("fields")).toContain("instagram_business_account")
    expect(calls[5]!.url.searchParams.get("after")).toBe("cursor-1")
    for (const secret of ["app-secret", "code-1", "short-token", "user-token"]) {
      expect(calls.map((call) => call.url.href).join(" ")).not.toContain(secret)
    }
  })

  test("leaves Instagram fields out of a grant without instagram_basic", async () => {
    fakeGraph({
      permissions: ["pages_show_list", "pages_manage_posts"],
      pages: [[{ id: "page-2", name: "Florist", access_token: "page-token-2" }]],
    })
    await meta(options).authentication.exchangeCode({ ...context, redirectUri }, { code: "code-1" })
    const pagesRead = calls.find((call) => call.url.pathname === "/v23.0/me/accounts")
    expect(pagesRead?.url.searchParams.get("fields")).toBe("id,name,access_token")
  })

  test("refuses a grant without any usable Page", async () => {
    fakeGraph({ pages: [[{ id: "no-task", name: "Read only" }]] })
    const error = await oauthRejection(() =>
      meta(options).authentication.exchangeCode({ ...context, redirectUri }, { code: "code-1" })
    )
    expect(error.kind).toBe("terminal")
    expect(error.message).toContain("granted no Pages")
  })

  test.each([
    [json({ error: { message: "Code was used", code: 100 } }, 400), "terminal"],
    [json({ error: { message: "Application request limit reached", code: 4 } }, 400), "retryable"],
    [json({ error: { message: "Unexpected" } }, 500), "retryable"],
    [new Response("<html>", { status: 200 }), "ambiguous"],
  ] as const)("classifies a failed code exchange %#", async (response, kind) => {
    route(() => response.clone())
    const error = await oauthRejection(() =>
      meta(options).authentication.exchangeCode({ ...context, redirectUri }, { code: "code-1" })
    )
    expect(error.kind).toBe(kind)
    expect(error.message).not.toContain("app-secret")
  })

  test("reports a lost code exchange as ambiguous", async () => {
    route(() => Promise.reject(new TypeError("socket closed")))
    const error = await oauthRejection(() =>
      meta(options).authentication.exchangeCode({ ...context, redirectUri }, { code: "code-1" })
    )
    expect(error.kind).toBe("ambiguous")
  })

  test("lists granted Pages and hands each connection its own Page token", async () => {
    const connector = meta(options)
    expect(await connector.discoverAccounts(context, grant)).toEqual([
      { id: "page-1", label: "Bakery", description: "Facebook Page · Instagram @bakery" },
      { id: "page-2", label: "Florist", description: "Facebook Page" },
    ])
    expect(
      connector.authentication.accountAccessToken?.(grant, { id: "page-2", label: "Florist" })
    ).toEqual({ accessToken: "page-token-2", tokenType: "Bearer" })
    expect(() =>
      connector.authentication.accountAccessToken?.(grant, { id: "gone", label: "Gone" })
    ).toThrow("does not include Page gone")
  })

  test("never refreshes: a new sign-in is the only way to extend a Facebook grant", async () => {
    const error = await oauthRejection(() => meta(options).authentication.refresh(context, grant))
    expect(error.kind).toBe("terminal")
  })

  test("revokes as the app, since the user token has usually expired by then", async () => {
    route(() => json({ success: true }))
    await meta(options).authentication.revoke?.(context, grant)
    expect(calls[0]!.method).toBe("DELETE")
    expect(calls[0]!.url.pathname).toBe("/v23.0/user-1/permissions")
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer app-id|app-secret")
    expect(calls[0]!.url.href).not.toContain("app-secret")

    route(() => json({ error: { message: "Unsupported delete request", code: 100 } }, 400))
    await meta(options).authentication.revoke?.(context, grant)

    // A rejected app token is a configuration error, not a revoked grant.
    route(invalidToken)
    const rejected = await oauthRejection(() =>
      meta(options).authentication.revoke?.(context, grant)
    )
    expect(rejected.kind).toBe("terminal")

    route(() => json({ error: { message: "Unexpected" } }, 500))
    const error = await oauthRejection(() => meta(options).authentication.revoke?.(context, grant))
    expect(error.kind).toBe("retryable")
  })
})

describe("Meta OAuth client", () => {
  test("scopes every request to the connected Page token and reads its Instagram link", async () => {
    route((call) =>
      call.url.pathname === "/v23.0/page-1"
        ? json({
            name: "Bakery & Co",
            instagram_business_account: { id: "ig-1", username: "bakery" },
          })
        : json({ data: [] })
    )
    const client = await connect(tokenSource().source)

    expect(client.account).toEqual({
      pageId: "page-1",
      name: "Bakery & Co",
      instagram: { id: "ig-1", username: "bakery" },
    })
    expect(client).not.toHaveProperty("pages")

    await client.facebook("page-1").posts.list()
    await client.instagram("ig-1").media.list()
    await client.instagram("ig-1", { accessToken: "explicit" }).media.list()
    expect(calls.map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer page-token-1",
      "Bearer page-token-1",
      "Bearer page-token-1",
      "Bearer explicit",
    ])
  })

  test("uploads with the Page token in Meta's OAuth scheme", async () => {
    route((call) =>
      call.url.hostname === "rupload.facebook.com"
        ? json({ success: true })
        : json({ name: "Bakery" })
    )
    const client = await connect(tokenSource().source)
    await client
      .facebook("page-1")
      .reels.upload(
        { video_id: "video", upload_url: "https://rupload.facebook.com/video-upload/v23.0/video" },
        { file_url: "https://cdn.example/video.mp4" }
      )
    expect(calls.at(-1)?.headers.get("authorization")).toBe("OAuth page-token-1")
  })

  // Regression check: make `rejectsAccessToken` in src/auth.ts return false and this test fails.
  test("sends a rejected Page token to reauthorization instead of returning a Graph error", async () => {
    route((call) =>
      call.url.pathname === "/v23.0/page-1" ? json({ name: "Bakery" }) : invalidToken()
    )
    const { source, state } = tokenSource()
    const client = await connect(source)

    const error = await client
      .facebook("page-1")
      .posts.list()
      .catch((caught) => caught)
    expect(error.message).toContain("require reauthorization")
    expect(state.invalidated).toBe(1)
  })

  test("returns the Graph error when the connection was reauthorized meanwhile", async () => {
    route((call) =>
      call.url.pathname === "/v23.0/page-1" ? json({ name: "Bakery" }) : invalidToken()
    )
    const { source, state } = tokenSource()
    state.reauthorized = true
    const client = await connect(source)

    const error = await client
      .facebook("page-1")
      .posts.list()
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(MetaApiError)
    expect(error.graphError?.code).toBe(190)
  })

  test("leaves a caller-supplied token's rejection to the caller", async () => {
    route((call) =>
      call.url.pathname === "/v23.0/page-1" ? json({ name: "Bakery" }) : invalidToken()
    )
    const { source, state } = tokenSource()
    const client = await connect(source)

    const error = await client
      .instagram("ig-1", { accessToken: "explicit" })
      .media.list()
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(MetaApiError)
    expect(state.invalidated).toBe(0)
  })

  test("does not treat other Graph errors as an invalid token", async () => {
    route((call) =>
      call.url.pathname === "/v23.0/page-1"
        ? json({ name: "Bakery" })
        : json({ error: { message: "Missing permission", code: 200 } }, 403)
    )
    const { source, state } = tokenSource()
    const client = await connect(source)

    const error = await client
      .facebook("page-1")
      .posts.list()
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(MetaApiError)
    expect(state.invalidated).toBe(0)
  })

  test("keeps the grant when Meta rejects the token for one Page only", async () => {
    route((call) =>
      call.url.pathname === "/v23.0/page-1"
        ? json({ name: "Bakery" })
        : json(
            { error: { message: "Error validating access token", code: 190, error_subcode: 492 } },
            400
          )
    )
    const { source, state } = tokenSource()
    const client = await connect(source)

    const error = await client
      .facebook("page-1")
      .posts.list()
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(MetaApiError)
    expect(state.invalidated).toBe(0)
  })

  test("connects without Instagram when the grant has no Instagram permission", async () => {
    route((call) =>
      call.url.searchParams.get("fields")?.includes("instagram")
        ? json({ error: { message: "(#10) Requires instagram_basic", code: 10 } }, 403)
        : json({ name: "Bakery" })
    )
    const client = await connect(tokenSource().source)
    expect(client.account).toEqual({ pageId: "page-1", name: "Bakery" })
    expect(calls.map((call) => call.url.searchParams.get("fields"))).toEqual([
      "name,instagram_business_account{id,username}",
      "name",
    ])
  })
})
