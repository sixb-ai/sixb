import { describe, expect, spyOn, test } from "bun:test"
import {
  type OidcClientAdapter,
  type OidcTokenResponse,
  oidc,
  type SendOidcInvitationInput,
} from "@sixb/auth-oidc"
import {
  defineGroup,
  defineMembershipPolicy,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const projectId = "test-project"
const securityAdmins = defineGroup("security-admins")
const commercial = defineGroup("commercial")

const Device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

class FakeOidcClient implements OidcClientAdapter {
  readonly codeVerifier = "verifier"
  tokenClaims: Readonly<Record<string, unknown>> = {
    sub: "00u-founder",
    email: "founder@acme.com",
    email_verified: true,
    name: "Founder",
  }

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
    _currentUrl: URL,
    checks: { readonly expectedNonce: string }
  ): Promise<OidcTokenResponse> {
    const claims = {
      ...this.tokenClaims,
      nonce: checks.expectedNonce,
    }
    return {
      access_token: "access-token",
      claims() {
        return claims
      },
    }
  }

  async fetchUserInfo(): Promise<Readonly<Record<string, unknown>>> {
    return this.tokenClaims
  }
}

function createRuntime(options: { readonly failInvitationDelivery?: boolean } = {}) {
  const storage = new InMemoryStorage()
  const client = new FakeOidcClient()
  const invitationMessages: SendOidcInvitationInput[] = []
  const sixb = new SixbHost({
    id: projectId,
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    groups: [securityAdmins, commercial],
    membershipPolicies: [
      defineMembershipPolicy("default-membership", {
        grantedTo: [securityAdmins],
        scope: [commercial],
        can: ["invite"],
      }),
    ],
    auth: oidc({
      id: "okta",
      issuer: "https://idp.example",
      clientId: "client-id",
      clientSecret: "client-secret",
      allowedDomains: ["acme.com"],
      bootstrapUsers: ["founder@acme.com"],
      bootstrapGroups: [securityAdmins],
      sendInvitation: async (message) => {
        if (options.failInvitationDelivery) {
          throw new Error("OIDC invitation delivery failed")
        }
        invitationMessages.push(message)
      },
      clientAdapter: client,
    }),
  })

  return {
    app: createSixbApi(
      new SixbServer({
        host: sixb,
        quiet: true,
        browser: createTestBrowserPolicy(),
      })
    ),
    client,
    invitationMessages,
    sixb,
    storage,
  }
}

async function seedAdminSession(storage: InMemoryStorage) {
  const credential = createSessionCredential("ses_admin")
  await storage.auth.users.create({
    id: "usr_admin",
    projectId,
    email: "admin@acme.com",
  })
  await storage.auth.groupMemberships.upsert({
    projectId,
    userId: "usr_admin",
    groupId: "security-admins",
    source: "manual",
  })
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId,
    userId: "usr_admin",
    strategyId: "okta",
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-17T10:00:00.000Z"),
    expiresAt: new Date("2099-05-17T10:00:00.000Z"),
  })

  return {
    cookie: `sixb_session=${credential.cookieValue}; sixb_csrf=csrf_1`,
    csrfHeader: { "x-sixb-csrf": "csrf_1" },
  }
}

function cookieValue(setCookie: string | null, name: string): string {
  const match = setCookie?.match(new RegExp(`${name}=([^;,\\s]+)`))
  if (!match) {
    throw new Error(`Cookie ${name} was not set`)
  }
  return match[1]
}

// The `name=value` pair of the cookie that binds a sign-in to the browser that started it.
function stateCookie(signIn: Response): string {
  const header = signIn.headers.getSetCookie().find((cookie) => cookie.startsWith("sixb_oidc_"))
  if (!header) {
    throw new Error("OIDC state cookie was not set")
  }
  return header.split(";")[0] ?? ""
}

function clearedStateCookie(cookie: string): string {
  return `${cookie.split("=")[0]}=; Path=/auth/callback; SameSite=Lax; HttpOnly; Max-Age=0`
}

async function startSignIn(app: ReturnType<typeof createRuntime>["app"]) {
  const response = await app.fetch(
    new Request(
      "http://api.localhost/auth/sign-in?audience=atlas&returnTo=http%3A%2F%2Fatlas.localhost%2F",
      { redirect: "manual" }
    )
  )
  const state = new URL(response.headers.get("location") ?? "").searchParams.get("state") ?? ""
  return { response, state, cookie: stateCookie(response) }
}

async function callback(
  app: ReturnType<typeof createRuntime>["app"],
  state: string,
  cookie?: string
): Promise<Response> {
  return app.fetch(
    new Request(`http://api.localhost/auth/callback?code=code&state=${state}`, {
      headers: cookie ? { cookie } : {},
      redirect: "manual",
    })
  )
}

async function completeSignIn(app: ReturnType<typeof createRuntime>["app"]): Promise<Response> {
  const signIn = await startSignIn(app)
  return callback(app, signIn.state, signIn.cookie)
}

describe("oidc auth routes", () => {
  test("redirects sign-in to the OIDC provider", async () => {
    const { app } = createRuntime()

    const response = await app.fetch(
      new Request(
        "http://api.localhost/auth/sign-in?audience=atlas&returnTo=http%3A%2F%2Fatlas.localhost%2Fobjects",
        { redirect: "manual" }
      )
    )
    const location = new URL(response.headers.get("location") ?? "")

    expect(response.status).toBe(303)
    expect(location.origin).toBe("https://idp.example")
    expect(location.searchParams.get("redirect_uri")).toBe("http://api.localhost/auth/callback")
    expect(location.searchParams.get("state")).toStartWith("oidc_")
  })

  test("callback creates a session, sets cookies, and exposes the session shape", async () => {
    const { app } = createRuntime()
    const signIn = await app.fetch(
      new Request(
        "http://api.localhost/auth/sign-in?audience=atlas&returnTo=http%3A%2F%2Fatlas.localhost%2Fdashboard",
        { redirect: "manual" }
      )
    )
    const providerUrl = new URL(signIn.headers.get("location") ?? "")
    const state = providerUrl.searchParams.get("state")

    const callback = await app.fetch(
      new Request(`http://api.localhost/auth/callback?code=code&state=${state}`, {
        headers: { cookie: stateCookie(signIn) },
        redirect: "manual",
      })
    )

    expect(callback.status).toBe(303)
    expect(callback.headers.get("location")).toBe("http://atlas.localhost/dashboard")
    const setCookie = callback.headers.get("set-cookie")
    const sessionCookie = cookieValue(setCookie, "sixb_session")
    const csrfCookie = cookieValue(setCookie, "sixb_csrf")
    expect(sessionCookie).toContain(".")
    expect(csrfCookie).toBeTruthy()

    const sessionResponse = await app.fetch(
      new Request("http://api.localhost/api/auth/session", {
        headers: {
          cookie: `sixb_session=${sessionCookie}`,
        },
      })
    )

    expect(sessionResponse.status).toBe(200)
    expect(await sessionResponse.json()).toMatchObject({
      authenticated: true,
      user: {
        email: "founder@acme.com",
        displayName: "Founder",
        groupIds: ["security-admins"],
      },
      session: {
        id: expect.any(String),
      },
    })
  })

  test("API browser OIDC callbacks use the stored audience and return target", async () => {
    const { app } = createRuntime()
    const signIn = await app.fetch(
      new Request(
        "http://api.localhost/auth/sign-in?audience=app&returnTo=http%3A%2F%2Fapp.localhost%2Fdashboard",
        { redirect: "manual" }
      )
    )
    const providerUrl = new URL(signIn.headers.get("location") ?? "")
    const state = providerUrl.searchParams.get("state")

    const callback = await app.fetch(
      new Request(
        `http://api.localhost/auth/callback?code=code&state=${state}&returnTo=http%3A%2F%2Fevil.localhost%2Fsteal`,
        { headers: { cookie: stateCookie(signIn) }, redirect: "manual" }
      )
    )

    expect(signIn.status).toBe(303)
    expect(providerUrl.searchParams.get("redirect_uri")).toBe("http://api.localhost/auth/callback")
    expect(callback.status).toBe(303)
    expect(callback.headers.get("location")).toBe("http://app.localhost/dashboard")
    const setCookie = callback.headers.get("set-cookie")
    const sessionCookie = cookieValue(setCookie, "sixb_session_app")
    expect(sessionCookie).toContain(".")
  })

  test("callback replay returns a generic error without setting session cookies", async () => {
    const { app } = createRuntime()
    const signIn = await app.fetch(
      new Request(
        "http://api.localhost/auth/sign-in?audience=atlas&returnTo=http%3A%2F%2Fatlas.localhost%2Fdashboard",
        { redirect: "manual" }
      )
    )
    const providerUrl = new URL(signIn.headers.get("location") ?? "")
    const callbackUrl = `http://api.localhost/auth/callback?code=code&state=${providerUrl.searchParams.get(
      "state"
    )}`

    const headers = { cookie: stateCookie(signIn) }
    await app.fetch(new Request(callbackUrl, { headers, redirect: "manual" }))
    const replay = await app.fetch(new Request(callbackUrl, { headers, redirect: "manual" }))

    expect(replay.status).toBe(400)
    expect(replay.headers.get("set-cookie")).not.toContain("sixb_session")
  })

  test("creates OIDC invitation emails and applies invited groups on callback", async () => {
    const { app, client, invitationMessages, storage } = createRuntime()
    const admin = await seedAdminSession(storage)

    const invite = await app.fetch(
      new Request("http://api.localhost/api/auth/invitations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: admin.cookie,
          ...admin.csrfHeader,
        },
        body: JSON.stringify({
          email: " Ava@Acme.COM ",
          groupIds: ["commercial"],
          returnTo: "http://atlas.localhost/dashboard",
        }),
      })
    )
    const inviteText = await invite.text()
    const inviteBody = JSON.parse(inviteText) as {
      readonly delivery: { readonly status: string }
      readonly invitation: { readonly email: string; readonly groupIds: readonly string[] }
    }

    expect(invite.status).toBe(201)
    expect(inviteBody).toMatchObject({
      invitation: {
        email: "ava@acme.com",
        groupIds: ["commercial"],
      },
      delivery: {
        status: "sent",
      },
    })
    expect(inviteText).not.toContain("token")
    expect(inviteText).not.toContain("state")
    expect(invitationMessages).toHaveLength(1)
    const invitationUrl = new URL(invitationMessages[0]?.url ?? "")
    expect(invitationMessages[0]).toMatchObject({
      email: "ava@acme.com",
      subject: "You are invited to Sixb",
    })
    expect(invitationUrl.pathname).toBe("/auth/sign-in")
    expect(invitationUrl.searchParams.get("audience")).toBe("atlas")
    expect(invitationUrl.searchParams.get("returnTo")).toBe("http://atlas.localhost/dashboard")

    client.tokenClaims = {
      sub: "00u-ava",
      email: "ava@acme.com",
      email_verified: true,
      name: "Ava Chen",
    }
    const signIn = await app.fetch(
      new Request(invitationUrl.toString(), {
        redirect: "manual",
      })
    )
    const providerUrl = new URL(signIn.headers.get("location") ?? "")
    const callback = await app.fetch(
      new Request(
        `http://api.localhost/auth/callback?code=code&state=${providerUrl.searchParams.get(
          "state"
        )}`,
        { headers: { cookie: stateCookie(signIn) }, redirect: "manual" }
      )
    )

    expect(callback.status).toBe(303)
    expect(callback.headers.get("location")).toBe("http://atlas.localhost/dashboard")
    await expect(
      storage.auth.groupMemberships.listForGroup({
        projectId,
        groupId: "commercial",
      })
    ).resolves.toMatchObject([{ groupId: "commercial", source: "invitation" }])
  })

  test("revokes OIDC invitations when delivery fails", async () => {
    const { app, storage } = createRuntime({ failInvitationDelivery: true })
    const admin = await seedAdminSession(storage)

    const response = await app.fetch(
      new Request("http://api.localhost/api/auth/invitations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://atlas.localhost",
          cookie: admin.cookie,
          ...admin.csrfHeader,
        },
        body: JSON.stringify({
          email: "ava@acme.com",
          groupIds: ["commercial"],
        }),
      })
    )

    expect(response.status).toBe(500)
    await expect(storage.auth.invitations.list({ projectId })).resolves.toMatchObject({
      total: 1,
      invitations: [{ email: "ava@acme.com", status: "revoked" }],
    })
  })

  test("callback names the address that hasn't been invited", async () => {
    const { app, client } = createRuntime()
    client.tokenClaims = { sub: "00u-stranger", email: "stranger@acme.com", email_verified: true }

    const callback = await completeSignIn(app)

    expect(callback.status).toBe(403)
    expect(callback.headers.get("set-cookie")).not.toContain("sixb_session")
    expect(await callback.text()).toContain("stranger@acme.com hasn't been invited.")
  })

  test("callback tells a suspended user their account is suspended", async () => {
    const { app, client, storage } = createRuntime()
    await storage.auth.users.create({ id: "usr_ava", projectId, email: "ava@acme.com" })
    await storage.auth.suspendUserAndRevokeSessions({
      projectId,
      userId: "usr_ava",
      suspendedAt: new Date("2026-05-17T09:00:00.000Z"),
    })
    client.tokenClaims = { sub: "00u-ava", email: "ava@acme.com", email_verified: true }

    const callback = await completeSignIn(app)

    expect(callback.status).toBe(403)
    expect(await callback.text()).toContain("ava@acme.com has been suspended.")
  })

  // Nobody signing in can fix a provider that vouches for no address, so the server log says what
  // to change even without SIXB_AUTH_DEBUG. The claim names are logged; their values are not.
  test("logs a provider that vouches for no address without SIXB_AUTH_DEBUG", async () => {
    const { app, client } = createRuntime()
    client.tokenClaims = { sub: "00u-entra", preferred_username: "alice@acme.com" }
    const logged = spyOn(console, "error").mockImplementation(() => {})

    try {
      const callback = await completeSignIn(app)

      expect(callback.status).toBe(403)
      expect(await callback.text()).toContain("didn't share an email address this app trusts")
      const line = String(logged.mock.calls[0]?.[0])
      expect(line).toContain("SignInRefusedError(no_trusted_address)")
      expect(line).toContain("preferred_username")
      expect(line).toContain("`trustedEmail`")
      expect(line).not.toContain("alice@acme.com")
    } finally {
      logged.mockRestore()
    }
  })
})

// A callback URL carries everything sign-in needs, so it must only complete in the browser that
// started that sign-in. Removing the `matchesOidcStateCookie` check from GET /auth/callback fails the
// refusal tests, comparing only the cookie's presence fails the different-value case, and giving
// every attempt's cookie the same name fails the two-tab case.
describe("oidc sign-in browser binding", () => {
  test("sign-in keeps the attempt's state in a cookie only the callback receives", async () => {
    const { app } = createRuntime()
    const signIn = await startSignIn(app)
    const [header] = signIn.response.headers.getSetCookie()

    expect(signIn.response.headers.getSetCookie()).toHaveLength(1)
    expect(signIn.cookie).toMatch(/^sixb_oidc_[\w-]{22}=/)
    expect(signIn.cookie.slice(signIn.cookie.indexOf("=") + 1)).toBe(signIn.state)
    expect(header).toMatch(/; Path=\/auth\/callback; SameSite=Lax; HttpOnly; Max-Age=(599|600)$/)

    const secure = await app.fetch(
      new Request(
        "https://api.localhost/auth/sign-in?audience=atlas&returnTo=http%3A%2F%2Fatlas.localhost%2F",
        { redirect: "manual" }
      )
    )
    expect(stateCookie(secure)).toStartWith("sixb_oidc_")
    expect(secure.headers.get("set-cookie")).toEndWith("; Secure")
  })

  test("callback without the state cookie is refused and leaves the attempt to its browser", async () => {
    const { app } = createRuntime()
    const signIn = await startSignIn(app)

    const refused = await callback(app, signIn.state)

    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain("This sign-in attempt could not be completed.")
    expect(refused.headers.get("set-cookie")).not.toContain("sixb_session")
    expect((await callback(app, signIn.state, signIn.cookie)).status).toBe(303)
  })

  test("callback is refused with another attempt's cookie or a different value", async () => {
    const { app } = createRuntime()
    const mine = await startSignIn(app)
    const theirs = await startSignIn(app)
    const theirName = theirs.cookie.split("=")[0]

    const otherAttempt = await callback(app, theirs.state, mine.cookie)
    const otherValue = await callback(app, theirs.state, `${theirName}=${mine.state}`)

    expect(otherAttempt.status).toBe(400)
    expect(otherAttempt.headers.get("set-cookie")).not.toContain("sixb_session")
    expect(otherValue.status).toBe(400)
    expect(otherValue.headers.get("set-cookie")).not.toContain("sixb_session")
  })

  test("callback clears the state cookie whether sign-in completes or is refused", async () => {
    const { app, client } = createRuntime()
    const completed = await startSignIn(app)
    const success = await callback(app, completed.state, completed.cookie)

    expect(success.status).toBe(303)
    expect(cookieValue(success.headers.get("set-cookie"), "sixb_session")).toContain(".")
    expect(success.headers.getSetCookie()).toContain(clearedStateCookie(completed.cookie))

    client.tokenClaims = { sub: "00u-stranger", email: "stranger@acme.com", email_verified: true }
    const refused = await startSignIn(app)
    const failure = await callback(app, refused.state, refused.cookie)

    expect(failure.status).toBe(403)
    expect(failure.headers.getSetCookie()).toEqual([clearedStateCookie(refused.cookie)])
  })

  test("sign-ins started in two tabs each complete", async () => {
    const { app } = createRuntime()
    const first = await startSignIn(app)
    const second = await startSignIn(app)
    const cookies = `${first.cookie}; ${second.cookie}`

    expect(first.cookie.split("=")[0]).not.toBe(second.cookie.split("=")[0])
    expect((await callback(app, second.state, cookies)).status).toBe(303)
    expect((await callback(app, first.state, cookies)).status).toBe(303)
  })
})
