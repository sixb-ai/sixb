import { afterEach, describe, expect, test } from "bun:test"
import { ConnectorOAuthError } from "@sixb/core"
import {
  LINKEDIN_ACCESS_TOKEN_URL,
  LINKEDIN_AUTHORIZATION_URL,
  LINKEDIN_PERMITTED_SERVICES_URL,
  linkedin,
} from "../src"
import { CONTEXT, DEFAULT_OPTIONS, json, mockFetch, type RecordedCall } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const AUTHORIZATION_CONTEXT = {
  ...CONTEXT,
  redirectUri: "https://api.sixb.test/auth/connectors/callback",
}

describe("linkedin managed OAuth", () => {
  test("builds the confidential web authorization URL with framework state", () => {
    const connector = linkedin(DEFAULT_OPTIONS)
    const authorizationUrl = connector.authentication.authorizationUrl(AUTHORIZATION_CONTEXT, {
      state: "attempt.signed-state",
      codeChallenge: "pkce-challenge",
      codeChallengeMethod: "S256",
    })
    const url = new URL(String(authorizationUrl))

    expect(url.origin + url.pathname).toBe(LINKEDIN_AUTHORIZATION_URL)
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe(DEFAULT_OPTIONS.clientId)
    expect(url.searchParams.get("redirect_uri")).toBe(AUTHORIZATION_CONTEXT.redirectUri)
    expect(url.searchParams.get("state")).toBe("attempt.signed-state")
    expect(url.searchParams.get("scope")).toBe("r_ads")
    expect(url.searchParams.get("code_challenge")).toBe("pkce-challenge")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  })

  test("exchanges an authorization code without sending the native-only PKCE verifier", async () => {
    let call: RecordedCall | undefined
    mockFetch(async (input, init) => {
      call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : String(init?.body),
      }
      return json({
        access_token: "access-1",
        expires_in: 3600,
        refresh_token: "refresh-1",
        refresh_token_expires_in: 31_536_000,
        scope: "r_ads%20r_ads_reporting",
        token_type: "Bearer",
      })
    })

    const before = Date.now()
    const credentials = await linkedin(DEFAULT_OPTIONS).authentication.exchangeCode(
      AUTHORIZATION_CONTEXT,
      { code: "authorization-code", codeVerifier: "must-not-be-sent" }
    )
    const parameters = new URLSearchParams(call?.body)

    expect(call?.url).toBe(LINKEDIN_ACCESS_TOKEN_URL)
    expect(call?.method).toBe("POST")
    expect(call?.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    expect(parameters.get("grant_type")).toBe("authorization_code")
    expect(parameters.get("code")).toBe("authorization-code")
    expect(parameters.get("client_id")).toBe(DEFAULT_OPTIONS.clientId)
    expect(parameters.get("client_secret")).toBe(DEFAULT_OPTIONS.clientSecret)
    expect(parameters.get("redirect_uri")).toBe(AUTHORIZATION_CONTEXT.redirectUri)
    expect(parameters.has("code_verifier")).toBe(false)
    expect(credentials).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
      scopes: ["r_ads", "r_ads_reporting"],
    })
    expect(credentials.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 3_600_000)
  })

  test("refreshes programmatic tokens and classifies provider rejections", async () => {
    const bodies: string[] = []
    mockFetch(async (_input, init) => {
      bodies.push(String(init?.body))
      return bodies.length === 1
        ? json({ access_token: "access-2", expires_in: 7200 })
        : json({ error: "invalid_grant", error_description: "expired" }, { status: 400 })
    })
    const authentication = linkedin(DEFAULT_OPTIONS).authentication

    const refreshed = await authentication.refresh(CONTEXT, {
      accessToken: "access-1",
      refreshToken: "refresh-1",
    })
    expect(refreshed.accessToken).toBe("access-2")
    expect(new URLSearchParams(bodies[0]).get("refresh_token")).toBe("refresh-1")

    try {
      await authentication.refresh(CONTEXT, {
        accessToken: "access-2",
        refreshToken: "expired-refresh",
      })
      throw new Error("expected refresh to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorOAuthError)
      expect((error as ConnectorOAuthError).kind).toBe("terminal")
      expect((error as Error).message).toContain("invalid_grant: expired")
    }
  })

  test("requires reauthorization when LinkedIn did not issue a refresh token", async () => {
    const authentication = linkedin(DEFAULT_OPTIONS).authentication
    await expect(
      authentication.refresh(CONTEXT, { accessToken: "access-1" })
    ).rejects.toMatchObject({
      kind: "terminal",
    })
  })

  test("exposes manual grant removal without claiming provider revocation support", () => {
    const authentication = linkedin(DEFAULT_OPTIONS).authentication

    // LinkedIn documents manual removal but no OAuth revocation endpoint for this flow.
    expect(authentication.revoke).toBeUndefined()
    expect(LINKEDIN_PERMITTED_SERVICES_URL).toBe(
      "https://www.linkedin.com/psettings/permitted-services"
    )
  })
})
