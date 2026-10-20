import { describe, expect, test } from "bun:test"
import {
  defineGroup,
  defineMembershipPolicy,
  InMemoryBroker,
  type SixbErrorContext,
  SixbHost,
} from "../src"
import {
  type AuthenticatedUserRequestSession,
  createSessionCredential,
  type InviteDeliveryStatus,
  type MagicLinkAuthStrategy,
  type OidcAuthStrategy,
} from "../src/auth"
import { type AuthorizationContext, emptyGrantIndex } from "../src/authorization"
import { flushSixbErrors } from "../src/error-reporting/internal"
import type { StoredDomainEvent } from "../src/events"
import { createDelegatedRequestScope } from "../src/execution/scopes"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const admins = defineGroup("admins")
const team = defineGroup("team")

type Deps = ReturnType<typeof createTestRuntimeDeps>

// What the provider sends at the next OIDC sign-in.
type ProviderProfile = { displayName?: string; avatarUrl?: string }

function sessionInput(id: string) {
  return {
    id,
    tokenHash: `${id}-hash`,
    createdAt: new Date("2026-05-16T10:00:00.000Z"),
    expiresAt: new Date("2099-05-16T10:00:00.000Z"),
  }
}

// Completes a sign-in through storage, as the real magic-link strategy does. The token is its hash.
function magicLinkStrategy(delivery: { status: InviteDeliveryStatus }): MagicLinkAuthStrategy {
  return {
    id: "magic-link",
    kind: "magicLink",
    async requestMagicLink() {
      return { status: "sent" }
    },
    async deliverInvitation() {
      return { status: delivery.status }
    },
    async completeMagicLinkSignIn(input) {
      const result = await input.authStorage.completeMagicLinkSignIn({
        projectId: input.projectId,
        magicLinkId: input.magicLinkId,
        tokenHash: input.token,
        completedAt: new Date(),
        newUserId: "usr_ava",
        newUserDisplayName: input.displayName,
        session: input.session,
      })
      return { ...result, returnTo: "/" }
    },
  }
}

// Signs Ava in with whatever profile the provider currently sends.
function oidcStrategy(provider: ProviderProfile): OidcAuthStrategy {
  let attempts = 0

  return {
    id: "okta",
    kind: "oidc",
    bootstrapGroupIds: [],
    async startOidcSignIn(): Promise<never> {
      throw new Error("unused")
    },
    async deliverInvitation() {
      return { status: "sent" }
    },
    providerProfileFields: () => ["displayName", "avatarUrl"],
    async completeOidcSignIn(input) {
      attempts += 1
      const attemptId = `oidc_${attempts}`
      await input.authStorage.oidcAuthorizationAttempts.create({
        id: attemptId,
        projectId: input.projectId,
        strategyId: "okta",
        stateHash: `${attemptId}-state`,
        nonceHash: "nonce",
        codeVerifier: "verifier",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      })

      const result = await input.authStorage.completeOidcSignIn({
        projectId: input.projectId,
        oidcAuthorizationAttemptId: attemptId,
        stateHash: `${attemptId}-state`,
        completedAt: new Date(),
        subject: "00u1",
        email: "ava@acme.com",
        ...provider,
        allowUserCreationWithoutInvitation: true,
        newUserId: "usr_ava",
        session: input.session,
      })
      return { ...result, returnTo: "/" }
    },
  }
}

function createRuntime(
  auth: MagicLinkAuthStrategy | OidcAuthStrategy,
  options: { readonly deps?: Deps; readonly onError?: (context: SixbErrorContext) => void } = {}
) {
  const deps = options.deps ?? createTestRuntimeDeps()
  const sixb = new SixbHost({
    id: "project-a",
    ontology: [] as const,
    ...deps,
    groups: [admins, team],
    membershipPolicies: [
      defineMembershipPolicy("team-members", {
        grantedTo: [admins],
        scope: [team],
        can: ["invite", "suspend"],
      }),
    ],
    auth,
    ...(options.onError ? { onError: (_error, context) => options.onError?.(context) } : {}),
  })

  return { deps, sixb }
}

async function memberEvents(sixb: SixbHost): Promise<readonly StoredDomainEvent[]> {
  return sixb.events.read({ topics: ["users"] })
}

async function signInWithMagicLink(sixb: SixbHost, deps: Deps, id: string, displayName?: string) {
  await deps.storage.auth.magicLinks.create({
    id,
    projectId: sixb.id,
    strategyId: "magic-link",
    email: "ava@acme.com",
    tokenHash: `${id}-token`,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  })

  return sixb.auth.completeMagicLinkSignIn({
    magicLinkId: id,
    token: `${id}-token`,
    session: sessionInput(`ses_${id}`),
    displayName,
  })
}

let oidcSignIns = 0
async function signInWithOidc(sixb: SixbHost) {
  oidcSignIns += 1
  return sixb.auth.completeOidcSignIn({
    requestUrl: "http://localhost/auth/oidc/callback",
    requestOrigin: "http://localhost",
    session: sessionInput(`ses_oidc_${oidcSignIns}`),
  })
}

async function seedSignedIn(
  sixb: SixbHost,
  deps: Deps,
  params: { readonly userId: string; readonly email: string; readonly groupId: string }
): Promise<AuthenticatedUserRequestSession> {
  const credential = createSessionCredential(`ses_${params.userId}`)
  await deps.storage.auth.users.create({
    id: params.userId,
    projectId: sixb.id,
    email: params.email,
  })
  await deps.storage.auth.groupMemberships.upsert({
    projectId: sixb.id,
    userId: params.userId,
    groupId: params.groupId,
    source: "manual",
  })
  await deps.storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: sixb.id,
    userId: params.userId,
    strategyId: "magic-link",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-16T10:00:00.000Z"),
    expiresAt: new Date("2099-05-16T10:00:00.000Z"),
  })

  const session = await sixb.auth.getSession(
    new Request("http://localhost/api/project", {
      headers: { cookie: `sixb_session_app=${credential.cookieValue}` },
    })
  )
  if (!session.authenticated) throw new Error("Expected a signed-in member.")

  return session
}

function readerContext(grants: { readonly users?: boolean } = {}): AuthorizationContext {
  return {
    principal: { type: "user", id: "usr_reader" },
    groupIds: [],
    roleIds: [],
    grants: { ...emptyGrantIndex(), "view:users": grants.users ?? false },
  }
}

describe("member events", () => {
  // To see this fail, emit `user.joined` whenever a sign-in completes.
  test("announce a member at their first sign-in only", async () => {
    const { deps, sixb } = createRuntime(magicLinkStrategy({ status: "sent" }))
    await deps.storage.auth.invitations.createOrUpdateActive({
      id: "inv_ava",
      projectId: sixb.id,
      email: "ava@acme.com",
      groupIds: [],
      expiresAt: new Date(Date.now() + 60_000),
    })

    await signInWithMagicLink(sixb, deps, "ml_1", "Ava Lovelace")
    await signInWithMagicLink(sixb, deps, "ml_2")

    const events = await memberEvents(sixb)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "user.joined",
      topic: "users",
      partitionKey: "usr_ava",
      idempotencyKey: "user.joined:usr_ava",
      payload: {
        user: {
          id: "usr_ava",
          email: "ava@acme.com",
          displayName: "Ava Lovelace",
          status: "active",
        },
        invitationId: "inv_ava",
      },
    })
  })

  // To see this fail, emit `user.profile.updated` on every sign-in of an existing member.
  test("announce the profile changes an identity provider makes at sign-in", async () => {
    const provider: ProviderProfile = { displayName: "Ava Lovelace" }
    const { sixb } = createRuntime(oidcStrategy(provider))

    await signInWithOidc(sixb)
    await signInWithOidc(sixb)

    provider.displayName = "Ava King"
    provider.avatarUrl = "https://images.acme.com/ava.png"
    await signInWithOidc(sixb)

    const events = await memberEvents(sixb)
    expect(events.map((event) => event.type)).toEqual(["user.joined", "user.profile.updated"])
    expect(events[1]?.payload).toEqual({
      user: {
        id: "usr_ava",
        email: "ava@acme.com",
        displayName: "Ava King",
        avatarUrl: "https://images.acme.com/ava.png",
        status: "active",
      },
      changes: {
        displayName: { operation: "updated", before: "Ava Lovelace", after: "Ava King" },
        avatarUrl: { operation: "created", after: "https://images.acme.com/ava.png" },
      },
    })
  })

  // To see this fail, drop the change check from `profileUpdatedEvents`.
  test("announce a profile edit only when a value changes", async () => {
    const { deps, sixb } = createRuntime(magicLinkStrategy({ status: "sent" }))
    const ava = await seedSignedIn(sixb, deps, {
      userId: "usr_ava",
      email: "ava@acme.com",
      groupId: "team",
    })

    await sixb.auth.updateProfile(ava, { displayName: "Ava Lovelace" })
    await sixb.auth.updateProfile(ava, { displayName: "Ava Lovelace" })
    await sixb.auth.updateProfile(ava, { displayName: null })

    const events = await memberEvents(sixb)
    expect(events.map((event) => event.payload)).toEqual([
      {
        user: expect.objectContaining({ id: "usr_ava", displayName: "Ava Lovelace" }),
        changes: { displayName: { operation: "created", after: "Ava Lovelace" } },
        requestedBy: { type: "user", id: "usr_ava" },
      },
      {
        user: expect.not.objectContaining({ displayName: expect.anything() }),
        changes: { displayName: { operation: "cleared", before: "Ava Lovelace", after: null } },
        requestedBy: { type: "user", id: "usr_ava" },
      },
    ])
  })

  // To see this fail, emit the status event without comparing the member's previous status.
  test("announce a suspension and a reactivation when the status changes", async () => {
    const { deps, sixb } = createRuntime(magicLinkStrategy({ status: "sent" }))
    const admin = await seedSignedIn(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupId: "admins",
    })
    await seedSignedIn(sixb, deps, { userId: "usr_ava", email: "ava@acme.com", groupId: "team" })

    await sixb.auth.suspendMember(admin, { userId: "usr_ava" })
    await sixb.auth.reactivateMember(admin, { userId: "usr_ava" })
    await sixb.auth.reactivateMember(admin, { userId: "usr_ava" })

    const events = await memberEvents(sixb)
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      [
        "user.suspended",
        {
          user: { id: "usr_ava", email: "ava@acme.com", status: "suspended" },
          requestedBy: { type: "user", id: "usr_admin" },
        },
      ],
      [
        "user.reactivated",
        {
          user: { id: "usr_ava", email: "ava@acme.com", status: "active" },
          requestedBy: { type: "user", id: "usr_admin" },
        },
      ],
    ])
  })

  // To see this fail, pass the member `requireManageableMember` read, instead of the one the
  // storage write returns, to `statusChangedEvents`: both calls then see an active member.
  test("announce what concurrent status changes did, as the storage applied them", async () => {
    const { deps, sixb } = createRuntime(magicLinkStrategy({ status: "sent" }))
    const admin = await seedSignedIn(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupId: "admins",
    })
    await seedSignedIn(sixb, deps, { userId: "usr_ava", email: "ava@acme.com", groupId: "team" })

    await Promise.all([
      sixb.auth.suspendMember(admin, { userId: "usr_ava" }),
      sixb.auth.suspendMember(admin, { userId: "usr_ava" }),
    ])
    await Promise.all([
      sixb.auth.reactivateMember(admin, { userId: "usr_ava" }),
      sixb.auth.suspendMember(admin, { userId: "usr_ava" }),
    ])

    const ava = await deps.storage.auth.users.getById({ projectId: sixb.id, id: "usr_ava" })
    const types = (await memberEvents(sixb)).map((event) => event.type)
    expect(types[0]).toBe("user.suspended")
    // Every published event is a real transition, and the last one matches the stored status.
    for (const [index, type] of types.entries()) {
      expect(type).not.toBe(types[index - 1])
    }
    expect(types.at(-1)).toBe(ava?.status === "active" ? "user.reactivated" : "user.suspended")
  })

  // To see this fail, drop the `users` case from `canViewEvent`: the reader then sees nothing.
  test("show member events only to readers of the member directory", async () => {
    const { deps, sixb } = createRuntime(magicLinkStrategy({ status: "sent" }))
    const ava = await seedSignedIn(sixb, deps, {
      userId: "usr_ava",
      email: "ava@acme.com",
      groupId: "team",
    })
    await sixb.auth.updateProfile(ava, { displayName: "Ava Lovelace" })

    const trusted = createTestSixb(sixb)
    const reader = createTestSixb(sixb, { authorization: readerContext({ users: true }) })
    const member = createTestSixb(sixb, { authorization: readerContext() })
    const shared = sixb.withScope(
      createDelegatedRequestScope({
        projectId: sixb.id,
        requestId: "shared-request",
        correlationId: "shared-correlation",
        objectRead: {
          selection: { kind: "selected", roots: [] },
          limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 1_024 },
        },
        actionApply: [],
      })
    )

    const types = async (runtime: { events: typeof trusted.events }) =>
      (await runtime.events.read({ topics: ["users"] })).map((event) => event.type)
    expect(await types(trusted)).toEqual(["user.profile.updated"])
    expect(await types(reader)).toEqual(["user.profile.updated"])
    expect(await types(member)).toEqual([])
    expect(await types(shared)).toEqual([])
  })

  // To see this fail, emit `user.invited` before the invitation is delivered.
  test("announce an invitation once it is delivered", async () => {
    const delivery: { status: InviteDeliveryStatus } = { status: "skipped" }
    const { deps, sixb } = createRuntime(magicLinkStrategy(delivery))
    const admin = await seedSignedIn(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupId: "admins",
    })
    const destination = { requestOrigin: "http://localhost", returnTo: "/" }

    await expect(
      sixb.auth.invite(admin, { email: "ava@acme.com", groups: [team] }, destination)
    ).rejects.toMatchObject({ code: "invalid_auth_input" })
    expect(await memberEvents(sixb)).toEqual([])

    delivery.status = "sent"
    const { invitation } = await sixb.auth.invite(
      admin,
      { email: "ava@acme.com", groups: [team] },
      destination
    )

    const events = await memberEvents(sixb)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "user.invited",
      partitionKey: "invitation:ava@acme.com",
      payload: {
        invitationId: invitation.id,
        email: "ava@acme.com",
        expiresAt: invitation.expiresAt.toISOString(),
        requestedBy: { type: "user", id: "usr_admin" },
      },
    })
    expect(events[0]?.payload).not.toHaveProperty("groupIds")
  })

  test("keep the auth change when its event cannot be delivered", async () => {
    const deps = createTestRuntimeDeps()
    const broker = new InMemoryBroker()
    const failure = new Error("broker unavailable")
    const reports: SixbErrorContext[] = []
    const { sixb } = createRuntime(magicLinkStrategy({ status: "sent" }), {
      deps: { ...deps, broker },
      onError: (context) => reports.push(context),
    })
    const ava = await seedSignedIn(sixb, deps, {
      userId: "usr_ava",
      email: "ava@acme.com",
      groupId: "team",
    })
    broker.append = () => Promise.reject(failure)

    const { profile } = await sixb.auth.updateProfile(ava, { displayName: "Ava Lovelace" })
    await flushSixbErrors(sixb)

    expect(profile.displayName).toBe("Ava Lovelace")
    expect(reports).toMatchObject([
      { type: "event.delivery.failed", eventTypes: ["user.profile.updated"] },
    ])
  })
})
