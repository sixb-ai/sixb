import { describe, expect, test } from "bun:test"
import { InMemoryAuthStorage } from "@pario/core"
import { OidcAuthError, type OidcClientAdapter, type OidcTokenResponse, oidc } from "../src"

const projectId = "project-a"

class FakeOidcClient implements OidcClientAdapter {
  readonly codeVerifier = "verifier"
  tokenClaims: Readonly<Record<string, unknown>> = {
    sub: "00u1",
    email: "ava@acme.com",
    email_verified: true,
    name: "Ava Chen",
    picture: "https://idp.example/avatar.png",
  }
  userInfo: Readonly<Record<string, unknown>> | undefined = {
    sub: "00u1",
    email: "ava@acme.com",
    email_verified: true,
    name: "Ava Chen",
    picture: "https://idp.example/avatar.png",
  }
  authorizationCodeGrantCalls: URL[] = []

  randomPKCECodeVerifier(): string {
    return this.codeVerifier
  }

  async calculatePKCECodeChallenge(codeVerifier: string): Promise<string> {
    return `challenge:${codeVerifier}`
  }

  async discovery(): Promise<unknown> {
    return { issuer: "https://idp.example" }
  }

  buildAuthorizationUrl(_config: unknown, parameters: Record<string, string>): URL {
    const url = new URL("https://idp.example/authorize")
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, value)
    }
    return url
  }

  async authorizationCodeGrant(
    _config: unknown,
    currentUrl: URL,
    checks: { readonly expectedNonce: string }
  ): Promise<OidcTokenResponse> {
    this.authorizationCodeGrantCalls.push(currentUrl)
    const claims = {
      ...this.tokenClaims,
      nonce: checks.expectedNonce,
    }
    return {
      access_token: this.userInfo ? "access-token" : undefined,
      claims() {
        return claims
      },
    }
  }

  async fetchUserInfo(): Promise<Readonly<Record<string, unknown>>> {
    return this.userInfo ?? {}
  }
}

function sessionInput(id = "ses_1") {
  return {
    id,
    tokenHash: `${id}-hash`,
    createdAt: new Date("2026-05-17T10:00:00.000Z"),
    expiresAt: new Date("2026-05-24T10:00:00.000Z"),
  }
}

async function startSignIn(input: {
  readonly authStorage: InMemoryAuthStorage
  readonly client: FakeOidcClient
  readonly bootstrapUsers?: readonly string[]
  readonly returnTo?: string
}) {
  const strategy = oidc({
    id: "okta",
    issuer: "https://idp.example",
    clientId: "client-id",
    clientSecret: "client-secret",
    allowedDomains: ["acme.com"],
    bootstrapUsers: input.bootstrapUsers,
    bootstrapGroups: ["security-admins"],
    clientAdapter: input.client,
  })
  const start = await strategy.startOidcSignIn({
    projectId,
    authStorage: input.authStorage,
    returnTo: input.returnTo ?? "/dashboard",
    requestOrigin: "http://localhost",
    now: new Date("2026-05-17T09:58:00.000Z"),
  })
  return { strategy, redirectTo: new URL(start.redirectTo) }
}

describe("oidc auth strategy", () => {
  test("creates an authorization attempt and redirects with state nonce and PKCE", async () => {
    const authStorage = new InMemoryAuthStorage()
    const client = new FakeOidcClient()
    const { redirectTo } = await startSignIn({ authStorage, client })
    const state = redirectTo.searchParams.get("state")
    const nonce = redirectTo.searchParams.get("nonce")
    const stateParts = state?.split(".") ?? []

    expect(redirectTo.origin).toBe("https://idp.example")
    expect(redirectTo.searchParams.get("response_type")).toBe("code")
    expect(redirectTo.searchParams.get("scope")).toBe("openid email profile")
    expect(redirectTo.searchParams.get("redirect_uri")).toBe("http://localhost/auth/callback")
    expect(redirectTo.searchParams.get("code_challenge")).toBe("challenge:verifier")
    expect(redirectTo.searchParams.get("code_challenge_method")).toBe("S256")
    expect(state).toStartWith("oidc_")
    expect(nonce).toBe(stateParts[2] ?? null)

    const attemptId = stateParts[0] ?? ""
    const attempt = await authStorage.oidcAuthorizationAttempts.getById({
      projectId,
      id: attemptId,
    })
    expect(attempt).toMatchObject({
      strategyId: "okta",
      codeVerifier: "verifier",
      returnTo: "/dashboard",
    })
    expect(attempt?.stateHash).not.toBe(state)
    expect(attempt?.nonceHash).not.toBe(nonce)
  })

  test("completes invited user sign-in and applies invitation groups", async () => {
    const authStorage = new InMemoryAuthStorage()
    const client = new FakeOidcClient()
    await authStorage.invitations.createOrUpdateActive({
      id: "inv_1",
      projectId,
      email: "ava@acme.com",
      groupIds: ["commercial"],
      createdAt: new Date("2026-05-17T09:57:00.000Z"),
      expiresAt: new Date("2026-05-24T09:57:00.000Z"),
    })
    const { strategy, redirectTo } = await startSignIn({ authStorage, client })

    const result = await strategy.completeOidcSignIn({
      projectId,
      authStorage,
      requestUrl: `http://localhost/auth/callback?code=code&state=${redirectTo.searchParams.get(
        "state"
      )}`,
      requestOrigin: "http://localhost",
      session: sessionInput(),
      now: new Date("2026-05-17T10:00:00.000Z"),
    })

    expect(result.returnTo).toBe("/dashboard")
    expect(result.user).toMatchObject({
      email: "ava@acme.com",
      displayName: "Ava Chen",
      avatarUrl: "https://idp.example/avatar.png",
    })
    expect(result.identity).toMatchObject({
      strategyId: "okta",
      subject: "00u1",
      userId: result.user.id,
    })
    expect(result.invitation).toMatchObject({ id: "inv_1", status: "accepted" })
    expect(result.groupMemberships).toMatchObject([{ groupId: "commercial" }])
  })

  test("allows first-user bootstrap and then closes bootstrap creation", async () => {
    const authStorage = new InMemoryAuthStorage()
    const client = new FakeOidcClient()
    client.tokenClaims = {
      sub: "00u-founder",
      email: "founder@acme.com",
      email_verified: true,
    }
    client.userInfo = {
      sub: "00u-founder",
      email: "founder@acme.com",
      email_verified: true,
    }
    const { strategy, redirectTo } = await startSignIn({
      authStorage,
      client,
      bootstrapUsers: ["founder@acme.com"],
    })

    const result = await strategy.completeOidcSignIn({
      projectId,
      authStorage,
      requestUrl: `http://localhost/auth/callback?code=code&state=${redirectTo.searchParams.get(
        "state"
      )}`,
      requestOrigin: "http://localhost",
      session: sessionInput("ses_founder"),
      now: new Date("2026-05-17T10:00:00.000Z"),
    })

    expect(result.user.email).toBe("founder@acme.com")
    expect(result.groupMemberships).toMatchObject([
      { groupId: "security-admins", source: "manual" },
    ])

    const secondClient = new FakeOidcClient()
    secondClient.tokenClaims = {
      sub: "00u-second",
      email: "second@acme.com",
      email_verified: true,
    }
    secondClient.userInfo = {
      sub: "00u-second",
      email: "second@acme.com",
      email_verified: true,
    }
    const second = await startSignIn({
      authStorage,
      client: secondClient,
      bootstrapUsers: ["second@acme.com"],
    })

    await expect(
      second.strategy.completeOidcSignIn({
        projectId,
        authStorage,
        requestUrl: `http://localhost/auth/callback?code=code&state=${second.redirectTo.searchParams.get(
          "state"
        )}`,
        requestOrigin: "http://localhost",
        session: sessionInput("ses_second"),
        now: new Date("2026-05-17T10:02:00.000Z"),
      })
    ).rejects.toBeInstanceOf(Error)
  })

  test("rejects disallowed domains and consumes the attempt after state validation", async () => {
    const authStorage = new InMemoryAuthStorage()
    const client = new FakeOidcClient()
    client.tokenClaims = {
      sub: "00u1",
      email: "ava@evil.com",
      email_verified: true,
    }
    client.userInfo = {
      sub: "00u1",
      email: "ava@evil.com",
      email_verified: true,
    }
    const { strategy, redirectTo } = await startSignIn({ authStorage, client })
    const state = redirectTo.searchParams.get("state") ?? ""

    await expect(
      strategy.completeOidcSignIn({
        projectId,
        authStorage,
        requestUrl: `http://localhost/auth/callback?code=code&state=${state}`,
        requestOrigin: "http://localhost",
        session: sessionInput(),
        now: new Date("2026-05-17T10:00:00.000Z"),
      })
    ).rejects.toBeInstanceOf(OidcAuthError)

    const attempt = await authStorage.oidcAuthorizationAttempts.getById({
      projectId,
      id: state.split(".")[0] ?? "",
    })
    expect(attempt?.consumedAt).toEqual(new Date("2026-05-17T10:00:00.000Z"))
  })

  test("rejects mismatched userinfo subjects", async () => {
    const authStorage = new InMemoryAuthStorage()
    const client = new FakeOidcClient()
    client.userInfo = {
      sub: "different",
      email: "ava@acme.com",
      email_verified: true,
    }
    const { strategy, redirectTo } = await startSignIn({ authStorage, client })

    await expect(
      strategy.completeOidcSignIn({
        projectId,
        authStorage,
        requestUrl: `http://localhost/auth/callback?code=code&state=${redirectTo.searchParams.get(
          "state"
        )}`,
        requestOrigin: "http://localhost",
        session: sessionInput(),
        now: new Date("2026-05-17T10:00:00.000Z"),
      })
    ).rejects.toBeInstanceOf(OidcAuthError)
  })
})
