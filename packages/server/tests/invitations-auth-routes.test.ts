import { describe, expect, test } from "bun:test"
import { magicLink, type SendMagicLinkInput } from "@sixb/auth-magic-link"
import { oidc, type SendOidcInvitationInput } from "@sixb/auth-oidc"
import {
  type AuthStrategy,
  defineGroup,
  defineMembershipPolicy,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type MembershipPolicyDefinition,
  prop,
  type SixbAuthConfig,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createSixbApi, SixbServer } from "../src/server"
import { confirmCallback, createTestBrowserPolicy, linkFromLatestMessage } from "./helpers"

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
    readonly auth?: SixbAuthConfig
    readonly membershipPolicies?: readonly MembershipPolicyDefinition[]
  } = {}
) {
  const storage = new InMemoryStorage()
  const { messages, sendMagicLink } = createSender()
  const defaultAuth = magicLink({
    allowedDomains: ["acme.com"],
    sendMagicLink,
  })
  const sixb = new SixbHost({
    id: projectId,
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    groups: [securityAdmins, commercial, finance],
    membershipPolicies: options.membershipPolicies ?? [
      defineMembershipPolicy("default-membership", {
        grantedTo: [securityAdmins],
        scope: [commercial],
        can: ["invite"],
      }),
    ],
    auth: options.auth ?? defaultAuth,
  })

  return {
    app: createSixbApi(
      new SixbServer({
        host: sixb,
        quiet: true,
        browser: createTestBrowserPolicy(),
      })
    ),
    messages,
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
    strategyId: "magic-link",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-17T10:00:00.000Z"),
    expiresAt: new Date("2099-05-17T10:00:00.000Z"),
  })

  return {
    cookie: `sixb_session_app=${credential.cookieValue}; sixb_csrf_app=csrf_1`,
    csrfHeader: { "x-sixb-csrf": "csrf_1" },
  }
}

const invitationOptionCases: Array<{
  readonly name: string
  readonly runtime: Parameters<typeof createRuntime>[0]
  readonly expected: unknown
}> = [
  {
    name: "scoped to the caller's membership policy",
    runtime: {},
    expected: {
      groups: [{ id: "commercial" }],
      canInviteWithoutGroups: true,
      capabilities: { createInvitation: { state: "enabled" } },
    },
  },
  {
    name: "merged from every applicable membership policy",
    runtime: {
      membershipPolicies: [
        defineMembershipPolicy("commercial-membership", {
          grantedTo: [securityAdmins],
          scope: [commercial],
          can: ["invite"],
        }),
        defineMembershipPolicy("finance-membership", {
          grantedTo: [securityAdmins],
          scope: [finance],
          can: ["invite"],
        }),
      ],
    },
    expected: {
      groups: [{ id: "commercial" }, { id: "finance" }],
      canInviteWithoutGroups: true,
      capabilities: { createInvitation: { state: "enabled" } },
    },
  },
  {
    name: "disabled when the user has no membership policy",
    runtime: { membershipPolicies: [] },
    expected: {
      groups: [],
      canInviteWithoutGroups: false,
      capabilities: {
        createInvitation: { state: "disabled", reason: "missing_membership_policy" },
      },
    },
  },
  {
    name: "disabled when delivery is unsupported",
    runtime: { auth: { id: "dev", kind: "dev" } satisfies AuthStrategy },
    expected: {
      groups: [{ id: "commercial" }],
      canInviteWithoutGroups: true,
      capabilities: {
        createInvitation: { state: "disabled", reason: "invitation_delivery_not_supported" },
      },
    },
  },
]

describe("auth invitation routes", () => {
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
          returnTo: "http://app.localhost/objects",
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

  test("reveals the delivered link once when explicitly requested", async () => {
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
          email: "ava@acme.com",
          groupIds: ["commercial"],
          revealLink: true,
        }),
      })
    )
    const body = (await response.json()) as {
      readonly delivery: {
        readonly link?: { readonly url: string; readonly expiresAt?: string }
      }
    }

    expect(response.status).toBe(201)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(body.delivery.link?.url).toBe(messages[0]?.url)
    expect(body.delivery.link?.expiresAt).toBeString()

    const list = await app.fetch(
      new Request("http://localhost/api/auth/invitations", {
        headers: { cookie: admin.cookie },
      })
    )
    const listed = await list.text()

    expect(listed).not.toContain(messages[0]?.url ?? "unreachable")
    expect(listed).not.toContain("token")
  })

  test("an invitation signs its recipient in to the app with the invited groups", async () => {
    const { app, messages, storage } = createRuntime()
    const admin = await seedAdminSession(storage)

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
          email: "app-user@acme.com",
          groupIds: ["commercial"],
        }),
      })
    )

    expect(response.status).toBe(201)
    // The emailed link signs in on the API, which keeps where it returns to.
    const link = linkFromLatestMessage(messages)
    expect(link.origin).toBe("http://api.localhost")
    expect(link.pathname).toBe("/auth/callback")
    expect(link.searchParams.get("returnTo")).toBeNull()
    // Invitations have no requesting browser, so no same-device fast path.
    expect(link.searchParams.get("requester")).toBeNull()
    const magicLink = await storage.auth.magicLinks.getById({
      projectId,
      id: link.searchParams.get("magicLinkId") ?? "",
    })
    expect(magicLink).toMatchObject({
      returnTo: "http://app.localhost/",
    })

    const callback = await confirmCallback(app, link)
    expect(callback.status).toBe(303)
    expect(callback.headers.get("location")).toBe("http://app.localhost/")
    expect(callback.headers.get("set-cookie")).toContain("sixb_session_app=")
    await expect(
      storage.auth.groupMemberships.listForGroup({
        projectId,
        groupId: "commercial",
      })
    ).resolves.toMatchObject([{ groupId: "commercial", source: "invitation" }])
  })

  test("rejects a return target outside the app", async () => {
    const { app, storage } = createRuntime()
    const admin = await seedAdminSession(storage)

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
          email: "app-user@acme.com",
          groupIds: ["commercial"],
          returnTo: "https://evil.test/objects",
        }),
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Invitation return target is not allowed" })
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
          origin: "http://app.localhost",
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
          revealLink: true,
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
        link: {
          url: messages[0]?.url,
        },
      },
    })
    expect(messages).toHaveLength(1)
    expect(signInUrl.origin).toBe("https://app.example.com")
    expect(signInUrl.pathname).toBe("/auth/sign-in")
    expect(signInUrl.searchParams.get("returnTo")).toBe("http://app.localhost/")
  })

  // The strategy refuses an address outside its allowed domains before anything is written or sent.
  test.each([
    { strategy: "magic-link", auth: undefined, email: "ava@example.com" },
    {
      strategy: "OIDC",
      auth: oidc({
        issuer: "https://idp.example",
        clientId: "client-id",
        clientSecret: "client-secret",
        allowedDomains: ["acme.com"],
      }),
      email: "oidc-user@example.com",
    },
  ])("rejects invitations when $strategy delivery cannot be sent", async ({ auth, email }) => {
    const { app, messages, storage } = createRuntime({ auth })
    const admin = await seedAdminSession(storage)

    const response = await app.fetch(
      new Request("http://localhost/api/auth/invitations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://app.localhost",
          cookie: admin.cookie,
          ...admin.csrfHeader,
        },
        body: JSON.stringify({ email, groupIds: ["commercial"] }),
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: `[Sixb] Invitation email '${email}' is not allowed by the active auth strategy.`,
    })
    expect(messages).toHaveLength(0)
    await expect(storage.auth.invitations.list({ projectId })).resolves.toMatchObject({ total: 0 })
  })

  test.each(invitationOptionCases)("returns invitation options $name", async ({
    runtime,
    expected,
  }) => {
    const { app, storage } = createRuntime(runtime)
    const admin = await seedAdminSession(storage)

    const response = await app.fetch(
      new Request("http://localhost/api/auth/invitation-options", {
        headers: { cookie: admin.cookie },
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expected)
  })

  test("lists and revokes invitations by membership policy scope", async () => {
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
