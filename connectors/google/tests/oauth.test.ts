import { afterEach, describe, expect, test } from "bun:test"
import {
  type ConnectorConnectionClientContext,
  ConnectorOAuthError,
  type ConnectorOAuthErrorKind,
  defineConnector,
} from "@sixb/core"
import type { GoogleOAuthOptions } from "../src/auth"
import { GoogleAuthError } from "../src/errors"
import { type GoogleConnector, type GoogleOAuthConnector, google } from "../src/google"
import { CONTEXT, json, mockFetch, restoreFetch } from "./helpers"

afterEach(restoreFetch)

const GMAIL = "https://www.googleapis.com/auth/gmail.readonly"
const EMAIL = "https://www.googleapis.com/auth/userinfo.email"
const OAUTH = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "client-secret",
  scopes: [GMAIL, "email"],
} as const satisfies GoogleOAuthOptions
const AUTHORIZATION_CONTEXT = {
  ...CONTEXT,
  redirectUri: "https://api.sixb.test/auth/connectors/callback",
}

function connector(oauth: Partial<GoogleOAuthOptions> = {}): GoogleOAuthConnector {
  return google({ auth: { oauth: { ...OAUTH, ...oauth } } })
}

interface TokenCall {
  readonly url: string
  readonly parameters: URLSearchParams
}

function recordTokenCalls(respond: (call: TokenCall) => Response): TokenCall[] {
  const calls: TokenCall[] = []
  mockFetch(async (input, init) => {
    const call = { url: String(input), parameters: new URLSearchParams(String(init?.body)) }
    calls.push(call)
    return respond(call)
  })
  return calls
}

async function oauthErrorKind(operation: unknown): Promise<ConnectorOAuthErrorKind> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorOAuthError)
    return (error as ConnectorOAuthError).kind
  }
  throw new Error("expected the OAuth operation to fail")
}

describe("google managed OAuth — configuration", () => {
  test("registers as an OAuth connector while the other auth modes stay static", () => {
    // defineConnector rejects an adapter that declares OAuth without the full lifecycle.
    const oauth = defineConnector("google", connector())
    const shared = defineConnector("google-shared", google({ auth: { token: () => "token" } }))

    expect(oauth.adapter.authentication.type).toBe("oauth2")
    expect(shared.adapter.authentication).toBeUndefined()

    const typed: GoogleConnector = google({ auth: { token: () => "token" } })
    // @ts-expect-error: a static credential never yields a managed OAuth adapter.
    const wrong: GoogleOAuthConnector = google({ auth: { token: () => "token" } })
    expect([typed.type, wrong.type]).toEqual(["google", "google"])
  })

  test("validates the OAuth client early", () => {
    expect(() => connector({ clientId: " " })).toThrow(GoogleAuthError)
    expect(() => connector({ clientId: " " })).toThrow("oauth.clientId must not be empty")
    expect(() => connector({ clientSecret: "" })).toThrow("oauth.clientSecret must not be empty")
    expect(() => connector({ scopes: [] })).toThrow("non-empty scope")
    expect(() => connector({ scopes: [GMAIL, " "] })).toThrow("non-empty scope")
    expect(() => connector({ hostedDomain: "https://example.com" })).toThrow(
      "oauth.hostedDomain must be a domain name"
    )
  })
})

describe("google managed OAuth — authorization", () => {
  test("requests offline access on a consent screen with PKCE and identity scopes", () => {
    const authentication = connector().authentication
    expect(authentication.pkce).toBeUndefined()

    const url = new URL(
      String(
        authentication.authorizationUrl(AUTHORIZATION_CONTEXT, {
          state: "attempt.signed-state",
          codeChallenge: "pkce-challenge",
          codeChallengeMethod: "S256",
        })
      )
    )

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: OAUTH.clientId,
      redirect_uri: AUTHORIZATION_CONTEXT.redirectUri,
      scope: `${GMAIL} ${EMAIL} openid`,
      state: "attempt.signed-state",
      access_type: "offline",
      prompt: "select_account consent",
      code_challenge: "pkce-challenge",
      code_challenge_method: "S256",
    })
  })

  test("hints the configured Workspace domain", () => {
    const url = new URL(
      String(
        connector({ hostedDomain: " Example.COM " }).authentication.authorizationUrl(
          AUTHORIZATION_CONTEXT,
          { state: "state" }
        )
      )
    )
    expect(url.searchParams.get("hd")).toBe("example.com")
  })

  test("exchanges the code with the client secret and PKCE verifier", async () => {
    const calls = recordTokenCalls(() =>
      json({
        access_token: "access-1",
        expires_in: 3599,
        refresh_token: "refresh-1",
        // Google reports `email` under its full name; the request used the short alias.
        scope: `openid ${GMAIL} ${EMAIL}`,
        token_type: "Bearer",
        id_token: "header.payload.signature",
      })
    )

    const before = Date.now()
    const credentials = await connector().authentication.exchangeCode(AUTHORIZATION_CONTEXT, {
      code: "authorization-code",
      codeVerifier: "pkce-verifier",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/token")
    expect(Object.fromEntries(calls[0]?.parameters ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "authorization-code",
      client_id: OAUTH.clientId,
      client_secret: OAUTH.clientSecret,
      redirect_uri: AUTHORIZATION_CONTEXT.redirectUri,
      code_verifier: "pkce-verifier",
    })
    expect(credentials).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      scopes: ["openid", GMAIL, EMAIL],
    })
    expect(credentials.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 3_599_000)
  })

  test("rejects a consent that left out a requested scope", async () => {
    recordTokenCalls(() =>
      json({ access_token: "access", refresh_token: "refresh", scope: `openid ${EMAIL}` })
    )

    const exchange = connector().authentication.exchangeCode(AUTHORIZATION_CONTEXT, {
      code: "code",
    })
    await expect(exchange).rejects.toThrow(`did not grant ${GMAIL}`)
    expect(await oauthErrorKind(exchange)).toBe("terminal")
  })

  test("requires a refresh token from the code exchange", async () => {
    recordTokenCalls(() => json({ access_token: "access", scope: `openid ${GMAIL} ${EMAIL}` }))

    const exchange = connector().authentication.exchangeCode(AUTHORIZATION_CONTEXT, {
      code: "code",
    })
    await expect(exchange).rejects.toThrow("did not issue a refresh token")
    expect(await oauthErrorKind(exchange)).toBe("terminal")
  })

  test("classifies code exchange failures by whether the code may be consumed", async () => {
    const exchange = () =>
      connector().authentication.exchangeCode(AUTHORIZATION_CONTEXT, { code: "code" })

    recordTokenCalls(() =>
      json({ error: "invalid_grant", error_description: "Bad Request" }, { status: 400 })
    )
    await expect(exchange()).rejects.toThrow("(400): invalid_grant: Bad Request")
    expect(await oauthErrorKind(exchange())).toBe("terminal")

    recordTokenCalls(() => json({ error: "rate_limited" }, { status: 429 }))
    expect(await oauthErrorKind(exchange())).toBe("retryable")

    recordTokenCalls(() => json({ error: "backend_error" }, { status: 503 }))
    expect(await oauthErrorKind(exchange())).toBe("ambiguous")

    mockFetch(async () => {
      throw new TypeError("connection reset")
    })
    expect(await oauthErrorKind(exchange())).toBe("ambiguous")
  })
})

describe("google managed OAuth — refresh and revocation", () => {
  test("refreshes the access token and leaves the refresh token to Sixb", async () => {
    const calls = recordTokenCalls(() =>
      json({ access_token: "access-2", expires_in: 3599, scope: `openid ${GMAIL} ${EMAIL}` })
    )

    const refreshed = await connector().authentication.refresh(CONTEXT, {
      accessToken: "access-1",
      refreshToken: "refresh-1",
    })

    expect(Object.fromEntries(calls[0]?.parameters ?? [])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: OAUTH.clientId,
      client_secret: OAUTH.clientSecret,
    })
    expect(refreshed.accessToken).toBe("access-2")
    // Google does not rotate refresh tokens; Sixb carries the stored one forward when omitted.
    expect(refreshed.refreshToken).toBeUndefined()
  })

  test("asks for reauthorization only when the grant itself is dead", async () => {
    const refresh = () =>
      connector().authentication.refresh(CONTEXT, { accessToken: "a", refreshToken: "r" })

    recordTokenCalls(() =>
      json(
        { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        { status: 400 }
      )
    )
    expect(await oauthErrorKind(refresh())).toBe("terminal")

    recordTokenCalls(() => json({ error: "admin_policy_enforced" }, { status: 400 }))
    expect(await oauthErrorKind(refresh())).toBe("terminal")

    // A rotated or deleted client secret breaks every refresh, but no grant: once the deployment
    // is fixed, every connection works again without users reconnecting.
    recordTokenCalls(() => json({ error: "invalid_client" }, { status: 401 }))
    expect(await oauthErrorKind(refresh())).toBe("retryable")

    recordTokenCalls(() => json({ error: "backend_error" }, { status: 503 }))
    expect(await oauthErrorKind(refresh())).toBe("retryable")

    mockFetch(async () => {
      throw new TypeError("connection reset")
    })
    expect(await oauthErrorKind(refresh())).toBe("retryable")

    expect(
      await oauthErrorKind(connector().authentication.refresh(CONTEXT, { accessToken: "a" }))
    ).toBe("terminal")
  })

  test("leaves revocation of the account's grant to its owner", () => {
    // Google revokes the account's whole grant to this client, which would also invalidate a
    // newer authorization of the same account that replaced the revoked one.
    expect(connector().authentication.revoke).toBeUndefined()
  })
})

describe("google managed OAuth — account discovery", () => {
  function recordUserinfo(body: unknown, init?: ResponseInit) {
    const calls: Array<{ url: string; authorization: string | null }> = []
    mockFetch(async (input, init_) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init_?.headers).get("authorization"),
      })
      return json(body, init)
    })
    return calls
  }

  test("returns the consenting Google account by its stable subject", async () => {
    const calls = recordUserinfo({
      sub: "1234567890",
      email: "ada@example.com",
      email_verified: true,
      name: "Ada Lovelace",
      picture: "https://lh3.googleusercontent.com/a/photo",
      hd: "example.com",
    })

    const accounts = await connector().discoverAccounts(CONTEXT, { accessToken: "access-1" })

    expect(calls).toEqual([
      {
        url: "https://openidconnect.googleapis.com/v1/userinfo",
        authorization: "Bearer access-1",
      },
    ])
    expect(accounts).toEqual([
      {
        id: "1234567890",
        label: "ada@example.com",
        description: "Ada Lovelace",
        avatarUrl: "https://lh3.googleusercontent.com/a/photo",
      },
    ])
  })

  test("accepts only accounts of the configured Workspace domain", async () => {
    const workspace = connector({ hostedDomain: "example.com" })

    recordUserinfo({ sub: "1", email: "ada@Example.com", hd: "Example.com" })
    expect(await workspace.discoverAccounts(CONTEXT, { accessToken: "a" })).toEqual([
      { id: "1", label: "ada@Example.com" },
    ])

    recordUserinfo({ sub: "2", email: "ada@other.com", hd: "other.com" })
    await expect(workspace.discoverAccounts(CONTEXT, { accessToken: "a" })).rejects.toThrow(
      "not part of the example.com Workspace domain"
    )

    // A consumer account asserts no domain, even when its address looks like one.
    recordUserinfo({ sub: "3", email: "ada@example.com" })
    expect(await oauthErrorKind(workspace.discoverAccounts(CONTEXT, { accessToken: "a" }))).toBe(
      "terminal"
    )
  })

  test("rejects an unusable profile and classifies lookup failures", async () => {
    const discover = () => connector().discoverAccounts(CONTEXT, { accessToken: "a" })

    recordUserinfo({ email: "ada@example.com" })
    await expect(discover()).rejects.toThrow("without a subject")

    recordUserinfo({ error: "invalid_token" }, { status: 401 })
    expect(await oauthErrorKind(discover())).toBe("terminal")

    recordUserinfo({ error: "backend_error" }, { status: 503 })
    expect(await oauthErrorKind(discover())).toBe("retryable")
  })
})

describe("google managed OAuth — client", () => {
  test("invalidates only the token a rejected request sent", async () => {
    let issued = 0
    const invalidated: number[] = []
    let secondIssued!: () => void
    const secondTokenIssued = new Promise<void>((resolve) => {
      secondIssued = resolve
    })
    const context: ConnectorConnectionClientContext = {
      ...CONTEXT,
      connectionId: "connection-1",
      account: { id: "1234567890", label: "ada@example.com" },
      tokenSource: {
        async get() {
          const revision = ++issued
          if (revision === 2) secondIssued()
          return {
            accessToken: `token-${revision}`,
            invalidate: () => invalidated.push(revision),
          }
        },
      },
    }
    const authorizations: string[] = []
    mockFetch(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? ""
      authorizations.push(authorization)
      if (authorization === "Bearer token-1") {
        // Reject the first request only after a concurrent request has taken a newer token.
        await secondTokenIssued
        return json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 })
      }
      return json({ id: "resource" })
    })

    const client = await connector().connect(context)
    const [file, calendar] = await Promise.all([
      client.drive.files.get("file-1"),
      client.calendar.calendars.get("primary"),
    ])

    expect(file.id).toBe("resource")
    expect(calendar.id).toBe("resource")
    expect(invalidated).toEqual([1])
    expect(authorizations.sort()).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-3"])
  })
})
