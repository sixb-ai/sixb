import { afterEach, describe, expect, jest, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import {
  type ConnectorConnectionClientContext,
  ConnectorOAuthError,
  type ConnectorOAuthErrorKind,
  defineConnector,
} from "@sixb/core"
import { type GitHubConnector, type GitHubOAuthConnector, github } from "../src/github"
import { githubOAuth } from "../src/sandbox"
import type { GitHubOAuthOptions } from "../src/types/options"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 })
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  jest.useRealTimers()
})

const CONTEXT = {
  projectId: "proj_test",
  connectorId: "github",
  signal: new AbortController().signal,
}

const AUTHORIZATION_CONTEXT = {
  ...CONTEXT,
  redirectUri: "https://api.sixb.test/auth/connectors/callback",
}

const OAUTH: GitHubOAuthOptions = {
  clientId: "Iv1.github123",
  clientSecret: "github-client-secret",
}

function connector(
  oauth: Partial<GitHubOAuthOptions> = {},
  baseUrl?: string
): GitHubOAuthConnector {
  return github({
    auth: { oauth: { ...OAUTH, ...oauth } },
    ...(baseUrl === undefined ? {} : { baseUrl }),
  })
}

async function oauthErrorKind(operation: Promise<unknown>): Promise<ConnectorOAuthErrorKind> {
  const error = await operation.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(ConnectorOAuthError)
  return (error as ConnectorOAuthError).kind
}

describe("github connector auth modes", () => {
  test("registers OAuth as a managed OAuth connector while token and App auth stay static", () => {
    const oauth = defineConnector("github-oauth", connector(), { owners: ["user"] })
    const pat = defineConnector("github-pat", github({ token: "ghp_static" }))
    const authToken = defineConnector(
      "github-auth-token",
      github({ auth: { token: "ghp_static" } })
    )
    const app = defineConnector(
      "github-app",
      github({ auth: { app: { appId: "123", privateKey: pem, installationId: 42 } } })
    )

    expect(oauth.adapter.authentication.type).toBe("oauth2")
    expect(oauth.owners).toEqual(["user"])
    expect(pat.adapter.authentication).toBeUndefined()
    expect(authToken.adapter.authentication).toBeUndefined()
    expect(app.adapter.authentication).toBeUndefined()

    const typed: GitHubConnector = github({ token: "ghp_static" })
    // @ts-expect-error: static credentials do not produce an OAuth connector adapter.
    const wrong: GitHubOAuthConnector = github({ token: "ghp_static" })
    expect([typed.type, wrong.type]).toEqual(["github", "github"])
  })

  test("rejects ambiguous or invalid auth configuration up front", () => {
    expect(() =>
      github({
        token: "ghp_1",
        auth: { token: "ghp_2" },
      } as unknown as Parameters<typeof github>[0])
    ).toThrow("Specify either token or auth, not both")
    expect(() => connector({ clientId: "bad:id" })).toThrow("oauth.clientId")
    expect(() => connector({ clientSecret: " " })).toThrow("oauth.clientSecret")
    expect(() => connector({ scopes: ["repo", ""] })).toThrow("oauth.scopes")
  })

  test("mints, caches, refreshes on 401, and revokes GitHub App installation tokens", async () => {
    // Regression proof: drop revision invalidation on 401; the second GET reuses token-1.
    const calls: { url: string; init?: RequestInit }[] = []
    let tokenNumber = 0
    let failFirstGet = true
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, init })
        if (url.endsWith("/app/installations/42/access_tokens")) {
          const bearer = new Headers(init?.headers).get("Authorization")!
          const [header, payload, signature] = bearer.slice("Bearer ".length).split(".")
          expect(
            verify(
              "RSA-SHA256",
              Buffer.from(`${header}.${payload}`),
              publicKey,
              Buffer.from(signature!, "base64url")
            )
          ).toBe(true)
          return Response.json({
            token: `ghs_token_${++tokenNumber}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          })
        }
        if (url.endsWith("/installation/token") && init?.method === "DELETE") {
          return new Response(null, { status: 204 })
        }
        if (url.endsWith("/user")) {
          const auth = new Headers(init?.headers).get("Authorization")
          if (failFirstGet) {
            failFirstGet = false
            return Response.json({ message: "Bad credentials" }, { status: 401 })
          }
          return Response.json({ id: 7, login: "sixb-bot", auth })
        }
        throw new Error(`Unexpected URL: ${url}`)
      },
      { preconnect() {} }
    ) as typeof fetch

    const adapter = github({
      auth: { app: { appId: "123", privateKey: pem, installationId: "42" } },
    })
    const client = await adapter.connect(CONTEXT)
    const first = await client.users.getAuthenticated()
    const second = await client.users.getAuthenticated()

    expect(tokenNumber).toBe(2)
    expect((first as unknown as { auth: string }).auth).toBe("Bearer ghs_token_2")
    expect((second as unknown as { auth: string }).auth).toBe("Bearer ghs_token_2")

    await adapter.disconnect?.(client)
    expect(calls.at(-1)?.url).toBe("https://api.github.com/installation/token")
    expect(calls.at(-1)?.init?.method).toBe("DELETE")
  })
})

describe("github managed OAuth", () => {
  test("builds authorization URLs with PKCE S256, offline_access, and Enterprise host derivation", () => {
    const auth = connector().authentication
    expect(auth.pkce).toBe("S256")

    const url = new URL(
      String(
        auth.authorizationUrl(AUTHORIZATION_CONTEXT, {
          state: "attempt.state",
          codeChallenge: "pkce-challenge",
          codeChallengeMethod: "S256",
        })
      )
    )
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "Iv1.github123",
      redirect_uri: AUTHORIZATION_CONTEXT.redirectUri,
      scope: "offline_access",
      state: "attempt.state",
      prompt: "select_account",
      code_challenge: "pkce-challenge",
      code_challenge_method: "S256",
    })

    const ghecUrl = new URL(
      String(
        connector({}, "https://api.acme.ghe.com/").authentication.authorizationUrl(
          AUTHORIZATION_CONTEXT,
          { state: "s" }
        )
      )
    )
    expect(ghecUrl.origin + ghecUrl.pathname).toBe("https://acme.ghe.com/login/oauth/authorize")
  })

  test("exchanges authorization codes, refreshes rotating tokens, and classifies HTTP 200 OAuth errors", async () => {
    // Regression proof: check only response.ok in requestToken; GitHub's HTTP 200 error payload is treated as an invalid response instead of terminal.
    const calls: { url: string; params: URLSearchParams }[] = []
    let responseBody: Record<string, unknown> = {
      access_token: "ghu_initial",
      refresh_token: "ghr_initial",
      expires_in: 28_800,
      token_type: "bearer",
      scope: "",
    }
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), params: new URLSearchParams(String(init?.body)) })
        return Response.json(responseBody)
      },
      { preconnect() {} }
    ) as typeof fetch

    const auth = connector().authentication
    const exchanged = await auth.exchangeCode(AUTHORIZATION_CONTEXT, {
      code: "oauth-code",
      codeVerifier: "verifier-123",
    })
    expect(calls[0]?.url).toBe("https://github.com/login/oauth/access_token")
    expect(Object.fromEntries(calls[0]!.params)).toEqual({
      client_id: "Iv1.github123",
      client_secret: "github-client-secret",
      code: "oauth-code",
      redirect_uri: AUTHORIZATION_CONTEXT.redirectUri,
      code_verifier: "verifier-123",
    })
    expect(exchanged).toMatchObject({
      accessToken: "ghu_initial",
      refreshToken: "ghr_initial",
      tokenType: "bearer",
    })
    expect(exchanged.expiresAt).toBeInstanceOf(Date)

    responseBody = {
      access_token: "ghu_refreshed",
      refresh_token: "ghr_refreshed",
      expires_in: 28_800,
      token_type: "bearer",
      scope: "",
    }
    const refreshed = await auth.refresh(CONTEXT, exchanged)
    expect(Object.fromEntries(calls[1]!.params)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "ghr_initial",
      client_id: "Iv1.github123",
      client_secret: "github-client-secret",
    })
    expect(refreshed.accessToken).toBe("ghu_refreshed")
    expect(refreshed.refreshToken).toBe("ghr_refreshed")

    responseBody = {
      error: "bad_verification_code",
      error_description: "The code passed is incorrect.",
    }
    expect(
      await oauthErrorKind(
        Promise.resolve(auth.exchangeCode(AUTHORIZATION_CONTEXT, { code: "expired" }))
      )
    ).toBe("terminal")

    responseBody = { error: "bad_refresh_token", error_description: "Refresh token expired." }
    expect(await oauthErrorKind(Promise.resolve(auth.refresh(CONTEXT, exchanged)))).toBe("terminal")

    responseBody = { error: "incorrect_client_credentials" }
    expect(await oauthErrorKind(Promise.resolve(auth.refresh(CONTEXT, exchanged)))).toBe(
      "retryable"
    )
  })

  test("validates comma-separated classic OAuth scopes and rejects missing grants", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          access_token: "gho_classic",
          token_type: "bearer",
          scope: "read:user",
        }),
      { preconnect() {} }
    ) as typeof fetch

    const auth = connector({ scopes: ["repo", "read:user"], pkce: "disabled" }).authentication
    expect(
      await oauthErrorKind(
        Promise.resolve(auth.exchangeCode(AUTHORIZATION_CONTEXT, { code: "code" }))
      )
    ).toBe("terminal")
  })

  test("discovers the authenticated GitHub user and revokes grants idempotently", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    let revokeStatus = 204
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, init })
        if (url.endsWith("/user")) {
          return Response.json({
            id: 4242,
            login: "adalovelace",
            name: "Ada Lovelace",
            avatar_url: "https://avatars.githubusercontent.com/u/4242",
          })
        }
        if (url.endsWith("/applications/Iv1.github123/grant")) {
          return new Response(null, { status: revokeStatus })
        }
        throw new Error(`Unexpected URL: ${url}`)
      },
      { preconnect() {} }
    ) as typeof fetch

    const adapter = connector()
    const accounts = await adapter.discoverAccounts(CONTEXT, { accessToken: "ghu_1" })
    expect(accounts).toEqual([
      {
        id: "4242",
        label: "adalovelace",
        description: "Ada Lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/4242",
      },
    ])

    await adapter.authentication.revoke!(CONTEXT, { accessToken: "ghu_1" })
    revokeStatus = 404
    await adapter.authentication.revoke!(CONTEXT, { accessToken: "ghu_1" })
    expect(calls[1]?.init?.method).toBe("DELETE")
    expect(new Headers(calls[1]?.init?.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("Iv1.github123:github-client-secret").toString("base64")}`
    )
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ access_token: "ghu_1" })
  })

  test("resolves a fresh OAuth token per request and invalidates the rejected token on 401", async () => {
    // Regression proof: drop onUnauthorized from github() OAuth connect; 401 does not invalidate token-1.
    let invalidated = 0
    let current = "ghu_stale"
    let firstAttempt = true
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("Authorization")
        if (firstAttempt) {
          firstAttempt = false
          return Response.json({ message: "Bad credentials" }, { status: 401 })
        }
        return Response.json({ id: 4242, login: "adalovelace", auth })
      },
      { preconnect() {} }
    ) as typeof fetch

    const context: ConnectorConnectionClientContext = {
      ...CONTEXT,
      connectionId: "ccn_1",
      account: { id: "4242", label: "adalovelace" },
      tokenSource: {
        async get() {
          const accessToken = current
          return {
            accessToken,
            invalidate() {
              invalidated++
              current = "ghu_fresh"
            },
          }
        },
      },
    }

    const client = await connector().connect(context)
    const user = await client.users.getAuthenticated()
    expect(invalidated).toBe(1)
    expect((user as unknown as { auth: string }).auth).toBe("Bearer ghu_fresh")
  })
})


describe("githubOAuth connector type wiring", () => {
  test("accepts an OAuth github() connector definition and rejects static ones at compile time", () => {
    const oauthConnector = defineConnector("github", connector(), { owners: ["user"] })
    const staticConnector = defineConnector("github-static", github({ token: "ghp_static" }))

    const sandboxAuth = githubOAuth({
      connector: oauthConnector,
      clientId: OAUTH.clientId,
      clientSecret: OAUTH.clientSecret,
    })
    expect(typeof sandboxAuth.authorize).toBe("function")

    expect(() =>
      githubOAuth({
        // @ts-expect-error: static GitHub connectors do not use OAuth connections
        connector: staticConnector,
        clientId: OAUTH.clientId,
        clientSecret: OAUTH.clientSecret,
      })
    ).toThrow("requires a GitHub OAuth connector")
  })
})
