import { afterEach, expect, test } from "bun:test"
import { ConnectorOAuthError } from "@sixb/core"
import { plaud } from "../src"
import { registerPlaudClient } from "../src/auth"
import { context, details, json, mockFetch } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const oauthContext = { ...context, redirectUri: "http://localhost:8200/auth/connectors/callback" }
const credentials = { accessToken: "access", refreshToken: "refresh" }
const tokenResponse = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  token_type: "bearer",
  expires_in: 3600,
}
const auth = () => plaud({ clientId: "client" }).authentication

test("public registration binds the deployment callbacks without a client secret", async () => {
  const redirectUris = [oauthContext.redirectUri, "https://example.test/auth/connectors/callback"]
  let calls = 0
  mockFetch((url, init) => {
    calls++
    expect(url.href).toBe("https://mcp.plaud.ai/register")
    expect(init.method).toBe("POST")
    expect(init.redirect).toBe("error")
    expect(new Headers(init.headers).has("authorization")).toBe(false)
    expect(JSON.parse(String(init.body))).toEqual({
      client_name: "Sixb",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    })
    return json(
      { client_id: "registered", redirect_uris: redirectUris, token_endpoint_auth_method: "none" },
      201
    )
  })
  expect(await registerPlaudClient({ redirectUris })).toEqual({
    clientId: "registered",
    redirectUris,
  })
  expect(calls).toBe(1)
})

test("invalid registration input is rejected before network access", async () => {
  let calls = 0
  mockFetch(() => {
    calls++
    return json({})
  })
  for (const redirectUris of [
    [],
    ["invalid"],
    ["http://example.test/callback"],
    ["https://a.test/#fragment"],
    ["https://user:secret@a.test/"],
    Array(5).fill(oauthContext.redirectUri),
  ]) {
    await expect(registerPlaudClient({ redirectUris })).rejects.toThrow("[SixbPlaud]")
  }
  await expect(
    registerPlaudClient({ redirectUris: [oauthContext.redirectUri], clientName: "x".repeat(65) })
  ).rejects.toThrow("clientName")
  expect(calls).toBe(0)
})

test("registration validates the returned client and callbacks", async () => {
  for (const response of [
    {
      client_id: "",
      token_endpoint_auth_method: "none",
      redirect_uris: [oauthContext.redirectUri],
    },
    {
      client_id: "client",
      token_endpoint_auth_method: "client_secret_basic",
      redirect_uris: [oauthContext.redirectUri],
    },
    {
      client_id: "client",
      token_endpoint_auth_method: "none",
      redirect_uris: ["https://unexpected.test/"],
    },
  ]) {
    mockFetch(() => json(response))
    await expect(registerPlaudClient({ redirectUris: [oauthContext.redirectUri] })).rejects.toThrow(
      "Invalid client registration"
    )
  }
})

test("authorization forwards Sixb state, callback and S256 challenge to the official OAuth server", async () => {
  const authentication = auth()
  expect(authentication.pkce).toBe("S256")
  const url = new URL(
    await authentication.authorizationUrl(oauthContext, {
      state: "sixb-state",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
    })
  )
  expect(url.origin + url.pathname).toBe("https://mcp.plaud.ai/authorize")
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: "client",
    response_type: "code",
    redirect_uri: oauthContext.redirectUri,
    state: "sixb-state",
    code_challenge: "challenge",
    code_challenge_method: "S256",
  })
  expect(() => authentication.authorizationUrl(oauthContext, { state: "state" })).toThrow(
    "PKCE S256"
  )
})

test("code exchange uses a public client and the Sixb PKCE verifier without callback state", async () => {
  mockFetch((url, init) => {
    expect(url.href).toBe("https://mcp.plaud.ai/token")
    expect(new Headers(init.headers).has("authorization")).toBe(false)
    expect(new Headers(init.headers).get("content-type")).toBe("application/x-www-form-urlencoded")
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      client_id: "client",
      grant_type: "authorization_code",
      code: "code",
      redirect_uri: oauthContext.redirectUri,
      code_verifier: "verifier",
    })
    return json(tokenResponse)
  })
  const result = await auth().exchangeCode(oauthContext, { code: "code", codeVerifier: "verifier" })
  expect(result).toMatchObject({
    accessToken: "new-access",
    refreshToken: "new-refresh",
    tokenType: "Bearer",
  })
  expect(result.expiresAt?.getTime()).toBeGreaterThan(Date.now())
})

test("refresh uses the same public endpoint and lets Sixb retain an omitted refresh token", async () => {
  mockFetch((url, init) => {
    expect(url.href).toBe("https://mcp.plaud.ai/token")
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      client_id: "client",
      grant_type: "refresh_token",
      refresh_token: "refresh",
    })
    expect(new Headers(init.headers).has("authorization")).toBe(false)
    return json({ access_token: "new", token_type: "Bearer" })
  })
  expect(await auth().refresh(context, credentials)).toEqual({
    accessToken: "new",
    tokenType: "Bearer",
  })
  expect(() => auth().refresh(context, { accessToken: "access" })).toThrow("Missing refresh token")
})

test("JWT expiry is a scheduling hint when expires_in is absent; opaque tokens remain valid", async () => {
  const access = `header.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")}.signature`
  mockFetch(() => json({ access_token: access }))
  expect((await auth().refresh(context, credentials)).expiresAt?.getTime()).toBe(2_000_000_000_000)
  mockFetch(() => json({ access_token: "opaque" }))
  expect((await auth().refresh(context, credentials)).expiresAt).toBeUndefined()
})

test("OAuth errors are classified without exposing response bodies or replaying mutations", async () => {
  for (const [status, kind] of [
    [400, "terminal"],
    [401, "terminal"],
    [403, "terminal"],
    [429, "retryable"],
    [503, "ambiguous"],
  ] as const) {
    let calls = 0
    mockFetch(() => {
      calls++
      return json({ error: "secret" }, status)
    })
    try {
      await auth().refresh(context, credentials)
      throw new Error("expected rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorOAuthError)
      expect(error).toHaveProperty("kind", kind)
      expect(String(error)).not.toContain("secret")
    }
    expect(calls).toBe(1)
  }
  let calls = 0
  mockFetch(() => {
    calls++
    throw new Error("secret network details")
  })
  await expect(auth().refresh(context, credentials)).rejects.toThrow("outcome is unknown")
  expect(calls).toBe(1)
})

test("malformed successful token responses have an ambiguous outcome", async () => {
  for (const response of [
    {},
    { access_token: "" },
    { access_token: "secret", refresh_token: "" },
    { access_token: "secret", token_type: "Basic" },
    { access_token: "secret", expires_in: -1 },
    { access_token: "secret", expires_in: 1e30 },
  ]) {
    mockFetch(() => json(response))
    try {
      await auth().refresh(context, credentials)
      throw new Error("expected rejection")
    } catch (error) {
      expect(error).toHaveProperty("kind", "ambiguous")
      expect(String(error)).not.toContain("secret")
    }
  }
  mockFetch(() => new Response("invalid JSON"))
  await expect(auth().refresh(context, credentials)).rejects.toThrow("Invalid OAuth JSON")
})

test("account discovery maps the authenticated profile and does not replay a rejected fixed token", async () => {
  const user = { id: "user", email: "user@example.test", nickname: "Example", avatar: null }
  mockFetch((url, init) => {
    expect(url.pathname).toBe("/developer/api/open/third-party/users/current")
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer access")
    return json(user)
  })
  expect(await plaud({ clientId: "client" }).discoverAccounts(context, credentials)).toEqual([
    { id: "user", label: "Example", description: "user@example.test" },
  ])
  let calls = 0
  mockFetch(() => {
    calls++
    return json({}, 401)
  })
  await expect(
    plaud({ clientId: "client" }).discoverAccounts(context, credentials)
  ).rejects.toThrow("HTTP 401")
  expect(calls).toBe(1)
})

test("a 401 invalidates the request's own token and replays with reacquired credentials", async () => {
  // Removal proof: remove onUnauthorized in src/http.ts, or replace the WeakMap lookup with a
  // shared latest token; either fails here. The second request's 200 races the first's 401.
  let gets = 0
  const invalidated: number[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const client = await plaud({ clientId: "client" }).connect({
    ...context,
    tokenSource: {
      async get() {
        const revision = ++gets
        return {
          accessToken: `t${revision}`,
          invalidate() {
            invalidated.push(revision)
          },
        }
      },
    },
  })
  const sent: (string | null)[] = []
  mockFetch(async (_url, init) => {
    const token = new Headers(init.headers).get("authorization")
    sent.push(token)
    if (token === "Bearer t1") {
      await gate
      return json({}, 401)
    }
    if (token === "Bearer t2") release()
    return json(details())
  })
  await Promise.all([client.recordings.get("r1"), client.recordings.get("r1")])
  expect(invalidated).toEqual([1])
  expect(gets).toBe(3)
  expect(sent).toEqual(["Bearer t1", "Bearer t2", "Bearer t3"])
})

test("cancellation stops OAuth before fetch, and timeouts are ambiguous without replay", async () => {
  let calls = 0
  mockFetch((_url, init) => {
    calls++
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    })
  })
  const stop = new Error("stop")
  const canceled = await Promise.resolve()
    .then(() => auth().refresh({ ...context, signal: AbortSignal.abort(stop) }, credentials))
    .catch((caught: unknown) => caught)
  expect(canceled).toBe(stop)
  expect(calls).toBe(0)
  const error = await Promise.resolve()
    .then(() =>
      plaud({ clientId: "client", timeoutMs: 1 }).authentication.refresh(context, credentials)
    )
    .catch((caught: unknown) => caught)
  expect(String(error)).toContain("outcome is unknown")
  expect(calls).toBe(1)
})
