import { describe, expect, test } from "bun:test"
import {
  type OidcClientAdapter,
  type OidcTokenResponse,
  oidc,
  type SendOidcInvitationInput,
} from "@pario/auth-oidc"
import {
  createSessionCredential,
  defineGroup,
  defineInvitePolicy,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  Pario,
  prop,
} from "@pario/core"
import { createParioApi, ParioServer } from "../src/server"

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
  latestGrantUrl: URL | null = null
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
    currentUrl: URL,
    checks: { readonly expectedNonce: string }
  ): Promise<OidcTokenResponse> {
    this.latestGrantUrl = currentUrl
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
  const pario = new Pario<readonly OntologySource[]>({
    id: projectId,
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    groups: [securityAdmins, commercial],
    invitePolicies: [
      defineInvitePolicy("default-invites", {
        grantedTo: [securityAdmins],
        canInviteTo: [commercial],
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
    app: createParioApi(new ParioServer({ pario, quiet: true, ui: false })),
    client,
    invitationMessages,
    pario,
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
    audience: "admin",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-17T10:00:00.000Z"),
    expiresAt: new Date("2099-05-17T10:00:00.000Z"),
  })

  return {
    cookie: `pario_session=${credential.cookieValue}; pario_csrf=csrf_1`,
    csrfHeader: { "x-pario-csrf": "csrf_1" },
  }
}

function cookieValue(setCookie: string | null, name: string): string {
  const match = setCookie?.match(new RegExp(`${name}=([^;,\\s]+)`))
  if (!match) {
    throw new Error(`Cookie ${name} was not set`)
  }
  return match[1]
}

describe("oidc auth routes", () => {
  test("redirects sign-in to the OIDC provider", async () => {
    const { app } = createRuntime()

    const response = await app.fetch(
      new Request("http://localhost/auth/sign-in?returnTo=/objects", { redirect: "manual" })
    )
    const location = new URL(response.headers.get("location") ?? "")

    expect(response.status).toBe(303)
    expect(location.origin).toBe("https://idp.example")
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost/auth/callback")
    expect(location.searchParams.get("state")).toStartWith("oidc_")
  })

  test("uses server publicOrigin for the OIDC redirect URI", async () => {
    const { pario } = createRuntime()
    const app = createParioApi(
      new ParioServer({
        pario,
        quiet: true,
        ui: false,
        publicOrigin: "https://app.example.com",
      })
    )

    const response = await app.fetch(
      new Request("http://internal.local/auth/sign-in?returnTo=/objects", { redirect: "manual" })
    )
    const location = new URL(response.headers.get("location") ?? "")

    expect(response.status).toBe(303)
    expect(location.searchParams.get("redirect_uri")).toBe("https://app.example.com/auth/callback")
  })

  test("uses server publicOrigin for the OIDC callback token exchange URL", async () => {
    const { client, pario } = createRuntime()
    const app = createParioApi(
      new ParioServer({
        pario,
        quiet: true,
        ui: false,
        publicOrigin: "https://app.example.com",
      })
    )
    const signIn = await app.fetch(
      new Request("http://internal.local/auth/sign-in?returnTo=/dashboard", { redirect: "manual" })
    )
    const providerUrl = new URL(signIn.headers.get("location") ?? "")
    const state = providerUrl.searchParams.get("state")

    const callback = await app.fetch(
      new Request(`http://internal.local/auth/callback?code=code&state=${state}`, {
        redirect: "manual",
      })
    )

    expect(callback.status).toBe(303)
    expect(client.latestGrantUrl?.origin).toBe("https://app.example.com")
    expect(client.latestGrantUrl?.pathname).toBe("/auth/callback")
    expect(client.latestGrantUrl?.searchParams.get("state")).toBe(state)
  })

  test("callback creates a session, sets cookies, and exposes the session shape", async () => {
    const { app } = createRuntime()
    const signIn = await app.fetch(
      new Request("http://localhost/auth/sign-in?returnTo=/dashboard", { redirect: "manual" })
    )
    const providerUrl = new URL(signIn.headers.get("location") ?? "")
    const state = providerUrl.searchParams.get("state")

    const callback = await app.fetch(
      new Request(`http://localhost/auth/callback?code=code&state=${state}`, {
        redirect: "manual",
      })
    )

    expect(callback.status).toBe(303)
    expect(callback.headers.get("location")).toBe("/dashboard")
    const setCookie = callback.headers.get("set-cookie")
    const sessionCookie = cookieValue(setCookie, "pario_session")
    const csrfCookie = cookieValue(setCookie, "pario_csrf")
    expect(sessionCookie).toContain(".")
    expect(csrfCookie).toBeTruthy()

    const sessionResponse = await app.fetch(
      new Request("http://localhost/api/auth/session", {
        headers: {
          cookie: `pario_session=${sessionCookie}`,
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

  test("callback replay returns a generic error without setting cookies", async () => {
    const { app } = createRuntime()
    const signIn = await app.fetch(
      new Request("http://localhost/auth/sign-in?returnTo=/dashboard", { redirect: "manual" })
    )
    const providerUrl = new URL(signIn.headers.get("location") ?? "")
    const callbackUrl = `http://localhost/auth/callback?code=code&state=${providerUrl.searchParams.get(
      "state"
    )}`

    await app.fetch(new Request(callbackUrl, { redirect: "manual" }))
    const replay = await app.fetch(new Request(callbackUrl, { redirect: "manual" }))

    expect(replay.status).toBe(400)
    expect(replay.headers.get("set-cookie")).toBeNull()
  })

  test("creates OIDC invitation emails and applies invited groups on callback", async () => {
    const { app, client, invitationMessages, storage } = createRuntime()
    const admin = await seedAdminSession(storage)

    const invite = await app.fetch(
      new Request("http://localhost/api/auth/invitations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: admin.cookie,
          ...admin.csrfHeader,
        },
        body: JSON.stringify({
          email: " Ava@Acme.COM ",
          groupIds: ["commercial"],
          returnTo: "/dashboard",
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
      subject: "You are invited to Pario",
    })
    expect(invitationUrl.pathname).toBe("/auth/sign-in")
    expect(invitationUrl.searchParams.get("returnTo")).toBe("/dashboard")

    client.tokenClaims = {
      sub: "00u-ava",
      email: "ava@acme.com",
      email_verified: true,
      name: "Ava Chen",
    }
    const signIn = await app.fetch(
      new Request(`http://localhost${invitationUrl.pathname}${invitationUrl.search}`, {
        redirect: "manual",
      })
    )
    const providerUrl = new URL(signIn.headers.get("location") ?? "")
    const callback = await app.fetch(
      new Request(
        `http://localhost/auth/callback?code=code&state=${providerUrl.searchParams.get("state")}`,
        { redirect: "manual" }
      )
    )

    expect(callback.status).toBe(303)
    expect(callback.headers.get("location")).toBe("/dashboard")
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
      new Request("http://localhost/api/auth/invitations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
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
})
