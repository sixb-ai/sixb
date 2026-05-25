import { describe, expect, test } from "bun:test"
import { magicLink, type SendMagicLinkInput } from "@pario/auth-magic-link"
import { oidc, type SendOidcInvitationInput } from "@pario/auth-oidc"
import {
  type AuthStrategy,
  createSessionCredential,
  defineGroup,
  defineInvitePolicy,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type InvitePolicyDefinition,
  type OntologySource,
  Pario,
  type ParioAuthConfig,
  prop,
} from "@pario/core"
import { createParioApi, ParioServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const projectId = "test-project"
const securityAdmins = defineGroup("security-admins")
const commercial = defineGroup("commercial")
const finance = defineGroup("finance")

const Device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

function createSender() {
  const messages: SendMagicLinkInput[] = []
  return {
    messages,
    async sendMagicLink(message: SendMagicLinkInput): Promise<void> {
      messages.push(message)
    },
  }
}

function createRuntime(
  options: {
    readonly auth?: ParioAuthConfig
    readonly invitePolicies?: readonly InvitePolicyDefinition[]
  } = {}
) {
  const storage = new InMemoryStorage()
  const { messages, sendMagicLink } = createSender()
  const defaultAuth = magicLink({
    allowedDomains: ["acme.com"],
    sendMagicLink,
  })
  const pario = new Pario<readonly OntologySource[]>({
    id: projectId,
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    groups: [securityAdmins, commercial, finance],
    invitePolicies: options.invitePolicies ?? [
      defineInvitePolicy("default-invites", {
        grantedTo: [securityAdmins],
        canInviteTo: [commercial],
        canInviteWithoutGroups: true,
      }),
    ],
    auth: options.auth ?? defaultAuth,
  })

  return {
    app: createParioApi(
      new ParioServer({
        pario,
        quiet: true,
        browser: createTestBrowserPolicy(),
      })
    ),
    messages,
    pario,
    storage,
  }
}

async function seedAdminSession(
  storage: InMemoryStorage,
  params: { readonly audience?: "atlas" | "app" } = {}
) {
  const credential = createSessionCredential("ses_admin")
  const audience = params.audience ?? "atlas"
  const cookieSuffix = audience === "atlas" ? "" : `_${audience}`
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
    strategyId: "magic-link",
    audience,
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-17T10:00:00.000Z"),
    expiresAt: new Date("2099-05-17T10:00:00.000Z"),
  })

  return {
    cookie: `pario_session${cookieSuffix}=${credential.cookieValue}; pario_csrf${cookieSuffix}=csrf_1`,
    csrfHeader: { "x-pario-csrf": "csrf_1" },
  }
}

function linkFromLatestMessage(messages: readonly { readonly text: string }[]): URL {
  const text = messages.at(-1)?.text ?? ""
  const match = text.match(/https?:\/\/\S+/)
  if (!match) {
    throw new Error("No magic link found in sent email")
  }
  return new URL(match[0])
}

describe("auth invitation routes", () => {
  test("requires authentication and CSRF for invitation mutations", async () => {
    const { app, storage } = createRuntime()
    const admin = await seedAdminSession(storage)

    const unauthenticated = await app.fetch(
      new Request("http://localhost/api/auth/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "ava@acme.com", groupIds: ["commercial"] }),
      })
    )
    const missingCsrf = await app.fetch(
      new Request("http://localhost/api/auth/invitations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: admin.cookie,
        },
        body: JSON.stringify({ email: "ava@acme.com", groupIds: ["commercial"] }),
      })
    )

    expect(unauthenticated.status).toBe(401)
    expect(missingCsrf.status).toBe(403)
  })

  test("creates an invitation, sends a magic link, and does not expose secrets", async () => {
    const { app, messages, storage } = createRuntime()
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
          email: " Ava@Acme.COM ",
          groupIds: ["commercial"],
          returnTo: "http://atlas.localhost/objects",
        }),
      })
    )
    const text = await response.text()
    const body = JSON.parse(text) as {
      readonly invitation: {
        readonly id: string
        readonly email: string
        readonly groupIds: string[]
      }
      readonly delivery: { readonly status: string }
    }

    expect(response.status).toBe(201)
    expect(body).toMatchObject({
      invitation: {
        email: "ava@acme.com",
        groupIds: ["commercial"],
      },
      delivery: {
        status: "sent",
      },
    })
    expect(text).not.toContain("token")
    expect(text).not.toContain("magicLink")
    expect(messages).toHaveLength(1)
    expect(messages[0]?.email).toBe("ava@acme.com")
  })

  test("creates invitations on the browser origin audience", async () => {
    const { pario, storage } = createRuntime()
    const app = createParioApi(
      new ParioServer({ pario, quiet: true, browser: createTestBrowserPolicy() })
    )
    const admin = await seedAdminSession(storage, { audience: "app" })

    const response = await app.fetch(
      new Request("http://api.localhost/api/auth/invitations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://app.localhost",
          cookie: admin.cookie,
          ...admin.csrfHeader,
        },
        body: JSON.stringify({
          email: "new@acme.com",
          groupIds: ["commercial"],
        }),
      })
    )

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      invitation: {
        email: "new@acme.com",
        groupIds: ["commercial"],
      },
    })
  })

  test("creates OIDC invitations without magic-link delivery", async () => {
    const { app, storage } = createRuntime({
      auth: oidc({
        issuer: "https://idp.example",
        clientId: "client-id",
        clientSecret: "client-secret",
        allowedDomains: ["acme.com"],
      }),
    })
    const admin = await seedAdminSession(storage)

    const options = await app.fetch(
      new Request("http://localhost/api/auth/invitation-options", {
        headers: { cookie: admin.cookie },
      })
    )
    const response = await app.fetch(
      new Request("http://localhost/api/auth/invitations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://atlas.localhost",
          cookie: admin.cookie,
          ...admin.csrfHeader,
        },
        body: JSON.stringify({
          email: "oidc-user@acme.com",
          groupIds: ["commercial"],
        }),
      })
    )

    expect(options.status).toBe(200)
    expect(await options.json()).toMatchObject({
      capabilities: {
        createInvitation: { state: "enabled" },
      },
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      invitation: {
        email: "oidc-user@acme.com",
        groupIds: ["commercial"],
        status: "pending",
      },
      delivery: {
        status: "not_supported",
      },
    })
  })

  test("sends OIDC invitation emails when the strategy configures a sender", async () => {
    const messages: SendOidcInvitationInput[] = []
    const { app, storage } = createRuntime({
      auth: oidc({
        issuer: "https://idp.example",
        clientId: "client-id",
        clientSecret: "client-secret",
        allowedDomains: ["acme.com"],
        publicUrl: "https://app.example.com",
        async sendInvitation(message) {
          messages.push(message)
        },
      }),
    })
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
          email: "oidc-user@acme.com",
          groupIds: ["commercial"],
          returnTo: "http://atlas.localhost/objects",
        }),
      })
    )
    const signInUrl = new URL(messages[0]?.url ?? "")

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      invitation: {
        email: "oidc-user@acme.com",
        groupIds: ["commercial"],
        status: "pending",
      },
      delivery: {
        status: "sent",
      },
    })
    expect(messages).toHaveLength(1)
    expect(signInUrl.origin).toBe("https://app.example.com")
    expect(signInUrl.pathname).toBe("/auth/sign-in")
    expect(signInUrl.searchParams.get("returnTo")).toBe("http://atlas.localhost/objects")
  })

  test("revokes OIDC invitations when invitation email sending fails", async () => {
    const { app, storage } = createRuntime({
      auth: oidc({
        issuer: "https://idp.example",
        clientId: "client-id",
        clientSecret: "client-secret",
        allowedDomains: ["acme.com"],
        async sendInvitation() {
          throw new Error("Email provider unavailable")
        },
      }),
    })
    const admin = await seedAdminSession(storage)

    const response = await app.fetch(
      new Request("http://localhost/api/auth/invitations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://atlas.localhost",
          cookie: admin.cookie,
          ...admin.csrfHeader,
        },
        body: JSON.stringify({
          email: "oidc-user@acme.com",
          groupIds: ["commercial"],
        }),
      })
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "Email provider unavailable" })
    await expect(
      storage.auth.invitations.getActiveByEmail({
        projectId,
        email: "oidc-user@acme.com",
        now: new Date(),
      })
    ).resolves.toBeNull()
  })

  test("rejects OIDC invitations outside the allowed domains", async () => {
    const { app, storage } = createRuntime({
      auth: oidc({
        issuer: "https://idp.example",
        clientId: "client-id",
        clientSecret: "client-secret",
        allowedDomains: ["acme.com"],
      }),
    })
    const admin = await seedAdminSession(storage)

    const response = await app.fetch(
      new Request("http://localhost/api/auth/invitations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://atlas.localhost",
          cookie: admin.cookie,
          ...admin.csrfHeader,
        },
        body: JSON.stringify({
          email: "oidc-user@example.com",
          groupIds: ["commercial"],
        }),
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error:
        "[Pario] Invitation email 'oidc-user@example.com' is not allowed by the active auth strategy.",
    })
    await expect(storage.auth.invitations.list({ projectId })).resolves.toMatchObject({ total: 0 })
  })

  test("returns scoped invitation options for the current user", async () => {
    const { app, storage } = createRuntime()
    const admin = await seedAdminSession(storage)

    const unauthenticated = await app.fetch(
      new Request("http://localhost/api/auth/invitation-options")
    )
    const response = await app.fetch(
      new Request("http://localhost/api/auth/invitation-options", {
        headers: { cookie: admin.cookie },
      })
    )

    expect(unauthenticated.status).toBe(401)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      groups: [{ id: "commercial" }],
      canInviteWithoutGroups: true,
      capabilities: {
        createInvitation: { state: "enabled" },
      },
    })
  })

  test("merges invitation options from applicable invite policies", async () => {
    const { app, storage } = createRuntime({
      invitePolicies: [
        defineInvitePolicy("commercial-invites", {
          grantedTo: [securityAdmins],
          canInviteTo: [commercial],
        }),
        defineInvitePolicy("finance-invites", {
          grantedTo: [securityAdmins],
          canInviteTo: [finance],
          canInviteWithoutGroups: true,
        }),
      ],
    })
    const admin = await seedAdminSession(storage)

    const response = await app.fetch(
      new Request("http://localhost/api/auth/invitation-options", {
        headers: { cookie: admin.cookie },
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      groups: [{ id: "commercial" }, { id: "finance" }],
      canInviteWithoutGroups: true,
      capabilities: {
        createInvitation: { state: "enabled" },
      },
    })
  })

  test("returns disabled invitation options when the user has no invite policy", async () => {
    const { app, storage } = createRuntime({ invitePolicies: [] })
    const admin = await seedAdminSession(storage)

    const response = await app.fetch(
      new Request("http://localhost/api/auth/invitation-options", {
        headers: { cookie: admin.cookie },
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      groups: [],
      canInviteWithoutGroups: false,
      capabilities: {
        createInvitation: {
          state: "disabled",
          reason: "missing_invite_policy",
        },
      },
    })
  })

  test("returns disabled invitation options when delivery is unsupported", async () => {
    const devAuth: AuthStrategy = { id: "dev", kind: "dev" }
    const { app, storage } = createRuntime({ auth: devAuth })
    const admin = await seedAdminSession(storage)

    const response = await app.fetch(
      new Request("http://localhost/api/auth/invitation-options", {
        headers: { cookie: admin.cookie },
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      groups: [{ id: "commercial" }],
      canInviteWithoutGroups: true,
      capabilities: {
        createInvitation: {
          state: "disabled",
          reason: "invitation_delivery_not_supported",
        },
      },
    })
  })

  test("returns invitation options on the browser origin audience", async () => {
    const { app, storage } = createRuntime()
    const admin = await seedAdminSession(storage, { audience: "app" })

    const response = await app.fetch(
      new Request("http://api.localhost/api/auth/invitation-options", {
        headers: {
          origin: "http://app.localhost",
          cookie: admin.cookie,
        },
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      groups: [{ id: "commercial" }],
      capabilities: {
        createInvitation: { state: "enabled" },
      },
    })
  })

  test("rejects invitations when magic-link delivery cannot be sent", async () => {
    const { app, messages, storage } = createRuntime()
    const admin = await seedAdminSession(storage)

    const response = await app.fetch(
      new Request("http://localhost/api/auth/invitations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://atlas.localhost",
          cookie: admin.cookie,
          ...admin.csrfHeader,
        },
        body: JSON.stringify({
          email: "ava@example.com",
          groupIds: ["commercial"],
        }),
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error:
        "[Pario] Invitation email 'ava@example.com' is not allowed by the active auth strategy.",
    })
    expect(messages).toHaveLength(0)
    await expect(storage.auth.invitations.list({ projectId })).resolves.toMatchObject({ total: 0 })
  })

  test("invited users can consume the emailed link and receive invitation groups", async () => {
    const { app, messages, storage } = createRuntime()
    const admin = await seedAdminSession(storage)

    await app.fetch(
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
          returnTo: "http://atlas.localhost/dashboard",
        }),
      })
    )

    const link = linkFromLatestMessage(messages)
    const callback = await app.fetch(
      new Request(link.toString(), {
        redirect: "manual",
      })
    )

    expect(callback.status).toBe(200)
    expect(callback.headers.get("location")).toBeNull()
    expect(await callback.text()).toContain(
      '<meta http-equiv="refresh" content="0;url=http://atlas.localhost/dashboard">'
    )
    await expect(
      storage.auth.groupMemberships.listForGroup({
        projectId,
        groupId: "commercial",
      })
    ).resolves.toMatchObject([{ groupId: "commercial", source: "invitation" }])
  })

  test("API browser invitations create API links that return to the calling UI origin", async () => {
    const { app, messages, storage } = createRuntime()
    const admin = await seedAdminSession(storage, { audience: "app" })

    const response = await app.fetch(
      new Request("http://api.localhost/api/auth/invitations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://app.localhost",
          cookie: admin.cookie,
          ...admin.csrfHeader,
        },
        body: JSON.stringify({
          email: "ava@acme.com",
          groupIds: ["commercial"],
        }),
      })
    )

    expect(response.status).toBe(201)
    const link = linkFromLatestMessage(messages)
    expect(link.origin).toBe("http://api.localhost")
    expect(link.pathname).toBe("/auth/callback")
    expect(link.searchParams.get("returnTo")).toBeNull()

    const magicLink = await storage.auth.magicLinks.getById({
      projectId,
      id: link.searchParams.get("magicLinkId") ?? "",
    })
    expect(magicLink).toMatchObject({
      audience: "app",
      returnTo: "http://app.localhost/",
    })
  })

  test("lists and revokes invitations by invite policy scope", async () => {
    const { app, storage } = createRuntime()
    const admin = await seedAdminSession(storage)
    await storage.auth.invitations.createOrUpdateActive({
      id: "inv_commercial",
      projectId,
      email: "commercial@acme.com",
      groupIds: ["commercial"],
      expiresAt: new Date("2099-05-17T10:00:00.000Z"),
    })
    await storage.auth.invitations.createOrUpdateActive({
      id: "inv_finance",
      projectId,
      email: "finance@acme.com",
      groupIds: ["finance"],
      expiresAt: new Date("2099-05-17T10:00:00.000Z"),
    })

    const list = await app.fetch(
      new Request("http://localhost/api/auth/invitations?order=asc", {
        headers: { cookie: admin.cookie },
      })
    )
    const listed = (await list.json()) as {
      readonly invitations: readonly { readonly id: string }[]
    }
    const unauthorizedRevoke = await app.fetch(
      new Request("http://localhost/api/auth/invitations/inv_finance/revoke", {
        method: "POST",
        headers: {
          cookie: admin.cookie,
          ...admin.csrfHeader,
        },
      })
    )
    const revoke = await app.fetch(
      new Request("http://localhost/api/auth/invitations/inv_commercial/revoke", {
        method: "POST",
        headers: {
          cookie: admin.cookie,
          ...admin.csrfHeader,
        },
      })
    )

    expect(list.status).toBe(200)
    expect(listed.invitations.map((invitation) => invitation.id)).toEqual(["inv_commercial"])
    expect(unauthorizedRevoke.status).toBe(403)
    expect(revoke.status).toBe(200)
    expect(await revoke.json()).toMatchObject({
      invitation: {
        id: "inv_commercial",
        status: "revoked",
      },
    })
  })
})
