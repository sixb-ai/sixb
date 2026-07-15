import { describe, expect, test } from "bun:test"
import { InMemoryAuthStorage } from "@sixb/core"
import type { CompleteAuthSessionInput } from "@sixb/core/storage"
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

function sessionInput(id = "ses_1"): CompleteAuthSessionInput {
  return {
    id,
    audience: "atlas",
    tokenHash: `${id}-hash`,
    createdAt: new Date("2026-05-17T10:00:00.000Z"),
    expiresAt: new Date("2026-05-24T10:00:00.000Z"),
  }
}

async function startSignIn(input: {
  readonly authStorage: InMemoryAuthStorage
  readonly client: FakeOidcClient
  readonly bootstrapUsers?: readonly string[]
  readonly bootstrapGroups?: readonly string[]
  readonly returnTo?: string
}) {
  const strategy = oidc({
    id: "okta",
    issuer: "https://idp.example",
    clientId: "client-id",
    clientSecret: "client-secret",
    allowedDomains: ["acme.com"],
    bootstrapUsers: input.bootstrapUsers,
    bootstrapGroups: input.bootstrapGroups ?? ["security-admins"],
    clientAdapter: input.client,
  })
  const start = await strategy.startOidcSignIn({
    projectId,
    authStorage: input.authStorage,
    audience: "atlas",
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
      audience: "atlas",
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

    expect(result.audience).toBe("atlas")
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

  test("provisions every bootstrap user, not just the first", async () => {
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
      bootstrapUsers: ["founder@acme.com", "second@acme.com"],
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

    // A second listed bootstrap user must still self-provision even though an
    // active user now exists.
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
      bootstrapUsers: ["founder@acme.com", "second@acme.com"],
    })

    const secondResult = await second.strategy.completeOidcSignIn({
      projectId,
      authStorage,
      requestUrl: `http://localhost/auth/callback?code=code&state=${second.redirectTo.searchParams.get(
        "state"
      )}`,
      requestOrigin: "http://localhost",
      session: sessionInput("ses_second"),
      now: new Date("2026-05-17T10:02:00.000Z"),
    })

    expect(secondResult.user.email).toBe("second@acme.com")
    expect(secondResult.groupMemberships).toMatchObject([
      { groupId: "security-admins", source: "manual" },
    ])
  })

  test("does not bootstrap an allowed-domain email absent from the bootstrap list", async () => {
    const authStorage = new InMemoryAuthStorage()
    const founderClient = new FakeOidcClient()
    founderClient.tokenClaims = {
      sub: "00u-founder",
      email: "founder@acme.com",
      email_verified: true,
    }
    founderClient.userInfo = founderClient.tokenClaims
    const founder = await startSignIn({
      authStorage,
      client: founderClient,
      bootstrapUsers: ["founder@acme.com"],
    })
    await founder.strategy.completeOidcSignIn({
      projectId,
      authStorage,
      requestUrl: `http://localhost/auth/callback?code=code&state=${founder.redirectTo.searchParams.get(
        "state"
      )}`,
      requestOrigin: "http://localhost",
      session: sessionInput("ses_founder"),
      now: new Date("2026-05-17T10:00:00.000Z"),
    })

    // Same allowed domain, but not on the bootstrap allowlist → needs an invite.
    const strangerClient = new FakeOidcClient()
    strangerClient.tokenClaims = {
      sub: "00u-stranger",
      email: "stranger@acme.com",
      email_verified: true,
    }
    strangerClient.userInfo = strangerClient.tokenClaims
    const stranger = await startSignIn({
      authStorage,
      client: strangerClient,
      bootstrapUsers: ["founder@acme.com"],
    })

    await expect(
      stranger.strategy.completeOidcSignIn({
        projectId,
        authStorage,
        requestUrl: `http://localhost/auth/callback?code=code&state=${stranger.redirectTo.searchParams.get(
          "state"
        )}`,
        requestOrigin: "http://localhost",
        session: sessionInput("ses_stranger"),
        now: new Date("2026-05-17T10:02:00.000Z"),
      })
    ).rejects.toBeInstanceOf(Error)
  })

  test("reconciles bootstrap groups for an existing user on later sign-in", async () => {
    const authStorage = new InMemoryAuthStorage()
    const client = new FakeOidcClient()
    client.tokenClaims = { sub: "00u-founder", email: "founder@acme.com", email_verified: true }
    client.userInfo = client.tokenClaims

    const first = await startSignIn({
      authStorage,
      client,
      bootstrapUsers: ["founder@acme.com"],
      bootstrapGroups: ["security-admins"],
    })
    const created = await first.strategy.completeOidcSignIn({
      projectId,
      authStorage,
      requestUrl: `http://localhost/auth/callback?code=code&state=${first.redirectTo.searchParams.get(
        "state"
      )}`,
      requestOrigin: "http://localhost",
      session: sessionInput("ses_founder"),
      now: new Date("2026-05-17T10:00:00.000Z"),
    })
    expect(created.groupMemberships).toMatchObject([
      { groupId: "security-admins", source: "manual" },
    ])

    // A newly-added bootstrap group must reach the already-existing bootstrap user
    // on their next sign-in, not only at first creation.
    const second = await startSignIn({
      authStorage,
      client,
      bootstrapUsers: ["founder@acme.com"],
      bootstrapGroups: ["security-admins", "billing-admins"],
    })
    const reSignIn = await second.strategy.completeOidcSignIn({
      projectId,
      authStorage,
      requestUrl: `http://localhost/auth/callback?code=code&state=${second.redirectTo.searchParams.get(
        "state"
      )}`,
      requestOrigin: "http://localhost",
      session: sessionInput("ses_founder_2"),
      now: new Date("2026-05-17T10:05:00.000Z"),
    })

    expect(reSignIn.user.id).toBe(created.user.id)
    const groupIds = (
      await authStorage.groupMemberships.listForUser({ projectId, userId: reSignIn.user.id })
    ).map((membership) => membership.groupId)
    expect(groupIds).toContain("security-admins")
    expect(groupIds).toContain("billing-admins")
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
