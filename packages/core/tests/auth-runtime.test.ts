import { describe, expect, setSystemTime, test } from "bun:test"
import {
  type AuthSessionOptions,
  type AuthStrategy,
  defineGroup,
  defineMembershipPolicy,
  Sixb,
} from "../src"
import {
  createAccessTokenCredential,
  createCsrfCookieHeader,
  createSessionCookieHeader,
  createSessionCredential,
  DEFAULT_AUTH_SESSION_CACHE_TTL_MS,
  DEFAULT_AUTH_SESSION_IDLE_TIMEOUT_MS,
  DEFAULT_AUTH_SESSION_RENEWAL_WINDOW_MS,
  formatSessionCookieValue,
  hashSessionSecret,
  type MagicLinkAuthStrategy,
  parseSessionCookieValue,
  resolveAuthConfig,
  resolveAuthCookieOptions,
  verifyDoubleSubmitCsrf,
} from "../src/auth"
import { decorateOperationScopedMethodForTesting } from "../src/storage/operation-scope"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const authStrategy = {
  id: "test",
  kind: "dev" as const,
}

const securityAdmins = defineGroup("security-admins")
const commercial = defineGroup("commercial")
const finance = defineGroup("finance")
const engineering = defineGroup("engineering")

const magicLinkStrategy: MagicLinkAuthStrategy = {
  id: "magic-link",
  kind: "magicLink" as const,
  bootstrapGroupIds: ["missing-group"],
  async requestMagicLink() {
    return { status: "skipped" as const }
  },
  async deliverInvitation() {
    return { status: "skipped" as const }
  },
  async completeMagicLinkSignIn(): Promise<never> {
    throw new Error("unused")
  },
}

async function seedAuthenticatedUser(
  sixb: Sixb<readonly []>,
  deps: ReturnType<typeof createTestRuntimeDeps>,
  params: { readonly userId: string; readonly email: string; readonly groupIds: readonly string[] }
): Promise<Request> {
  const credential = createSessionCredential(`ses_${params.userId}`)
  await deps.storage.auth.users.create({
    id: params.userId,
    projectId: sixb.id,
    email: params.email,
  })
  for (const groupId of params.groupIds) {
    await deps.storage.auth.groupMemberships.upsert({
      projectId: sixb.id,
      userId: params.userId,
      groupId,
      source: "manual",
    })
  }
  await deps.storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: sixb.id,
    userId: params.userId,
    strategyId: "magic-link",
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-16T10:00:00.000Z"),
    expiresAt: new Date("2099-05-16T10:00:00.000Z"),
  })

  return new Request("http://localhost/api/auth/invitations", {
    headers: { cookie: `sixb_session=${credential.cookieValue}` },
  })
}

function createInviteRuntime(options: { readonly strategy?: MagicLinkAuthStrategy } = {}) {
  const deps = createTestRuntimeDeps()
  const requests: Parameters<MagicLinkAuthStrategy["requestMagicLink"]>[0][] = []
  const strategy: MagicLinkAuthStrategy =
    options.strategy ??
    ({
      id: "magic-link",
      kind: "magicLink" as const,
      async requestMagicLink(input) {
        requests.push(input)
        return { status: "sent" as const }
      },
      async deliverInvitation(input) {
        requests.push({
          projectId: input.projectId,
          authStorage: input.authStorage,
          email: input.invitation.email,
          audience: input.audience,
          returnTo: input.returnTo,
          requestOrigin: input.requestOrigin,
          now: input.now,
        })
        return { status: "sent" as const }
      },
      async completeMagicLinkSignIn(): Promise<never> {
        throw new Error("unused")
      },
    } satisfies MagicLinkAuthStrategy)
  const sixb = new Sixb<readonly []>({
    id: "project-a",
    ontology: [] as const,
    ...deps,
    groups: [securityAdmins, commercial, finance],
    membershipPolicies: [
      defineMembershipPolicy("default-membership", {
        grantedTo: [securityAdmins],
        scope: [commercial],
        can: ["invite"],
      }),
    ],
    auth: strategy,
  })

  return { deps, sixb, requests }
}

describe("Sixb auth runtime", () => {
  test("formats, parses, and hashes opaque session cookie credentials", () => {
    const credential = createSessionCredential("ses_1")

    expect(credential.cookieValue).toBe(
      formatSessionCookieValue(credential.sessionId, credential.sessionSecret)
    )
    expect(parseSessionCookieValue(credential.cookieValue)).toEqual({
      sessionId: credential.sessionId,
      sessionSecret: credential.sessionSecret,
    })
    expect(hashSessionSecret(credential.sessionSecret)).toMatch(/^[a-f0-9]{64}$/)
    expect(parseSessionCookieValue("ses_1")).toBeNull()
    expect(parseSessionCookieValue("ses_1.secret.extra")).toBeNull()
  })

  test("resolves authenticated sessions with user groups", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({
      ontology: [],
      ...deps,
      auth: authStrategy,
    })
    const credential = createSessionCredential("ses_1")

    await deps.storage.auth.users.create({
      id: "usr_1",
      projectId: sixb.id,
      email: "ava@acme.com",
    })
    await deps.storage.auth.groupMemberships.upsert({
      projectId: sixb.id,
      userId: "usr_1",
      groupId: "commercial",
      source: "manual",
    })
    await deps.storage.auth.sessions.create({
      id: credential.sessionId,
      projectId: sixb.id,
      userId: "usr_1",
      strategyId: "test",
      audience: "atlas",
      tokenHash: credential.tokenHash,
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })

    const session = await sixb.auth.getSession(
      new Request("http://localhost/api/project", {
        headers: { cookie: `sixb_session=${credential.cookieValue}` },
      })
    )

    expect(session).toMatchObject({
      authenticated: true,
      principal: { type: "user", id: "usr_1" },
      user: { id: "usr_1", email: "ava@acme.com" },
      groupIds: ["commercial"],
    })
  })

  test("resolves personal access tokens with constrained user groups", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({
      ontology: [],
      ...deps,
      auth: authStrategy,
    })
    const credential = createAccessTokenCredential("personal", "tok_personal")

    await deps.storage.auth.users.create({
      id: "usr_1",
      projectId: sixb.id,
      email: "ava@acme.com",
    })
    for (const groupId of ["commercial", "finance"]) {
      await deps.storage.auth.groupMemberships.upsert({
        projectId: sixb.id,
        userId: "usr_1",
        groupId,
        source: "manual",
      })
    }
    await deps.storage.auth.accessTokens.create({
      id: credential.tokenId,
      projectId: sixb.id,
      name: "Local CLI",
      kind: "personal",
      subjectType: "user",
      subjectId: "usr_1",
      tokenHash: credential.tokenHash,
      groupIds: ["finance"],
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })

    const request = new Request("http://localhost/api/project", {
      headers: { authorization: `Bearer ${credential.tokenValue}` },
    })

    await expect(sixb.auth.getSession(request)).resolves.toEqual({
      authenticated: false,
      reason: "missing_cookie",
    })

    const session = await sixb.auth.getSession(request, { credentialSource: "accessToken" })
    expect(session).toMatchObject({
      authenticated: true,
      credentialSource: "accessToken",
      principal: { type: "user", id: "usr_1" },
      user: { id: "usr_1", email: "ava@acme.com" },
      accessToken: { id: "tok_personal", name: "Local CLI" },
      groupIds: ["finance"],
    })
    await expect(
      deps.storage.auth.accessTokens.getById({ projectId: sixb.id, id: "tok_personal" })
    ).resolves.toMatchObject({
      lastUsedAt: expect.any(Date),
    })
  })

  test("resolves service account access tokens with service account groups", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({
      ontology: [],
      ...deps,
      auth: authStrategy,
    })
    const credential = createAccessTokenCredential("serviceAccount", "tok_service")

    await deps.storage.auth.serviceAccounts.create({
      id: "svc_ingest",
      projectId: sixb.id,
      name: "Ingest worker",
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
    })
    await deps.storage.auth.serviceAccountGroupMemberships.upsert({
      projectId: sixb.id,
      serviceAccountId: "svc_ingest",
      groupId: "commercial",
      source: "manual",
    })
    await deps.storage.auth.accessTokens.create({
      id: credential.tokenId,
      projectId: sixb.id,
      name: "Sandbox agent",
      kind: "serviceAccount",
      subjectType: "serviceAccount",
      subjectId: "svc_ingest",
      tokenHash: credential.tokenHash,
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })

    const request = new Request("http://localhost/api/project", {
      headers: { authorization: `Bearer ${credential.tokenValue}` },
    })
    const session = await sixb.auth.getSession(request, { credentialSource: "any" })
    expect(session).toMatchObject({
      authenticated: true,
      credentialSource: "accessToken",
      principal: { type: "serviceAccount", id: "svc_ingest" },
      serviceAccount: { id: "svc_ingest", name: "Ingest worker" },
      groupIds: ["commercial"],
    })

    await deps.storage.auth.serviceAccounts.update({
      projectId: sixb.id,
      id: "svc_ingest",
      status: "suspended",
    })
    await expect(sixb.auth.getSession(request, { credentialSource: "any" })).resolves.toEqual({
      authenticated: false,
      reason: "suspended_service_account",
    })
  })

  test("creates and revokes personal and service account access tokens", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({
      ontology: [],
      ...deps,
      auth: authStrategy,
    })
    const sessionCredential = createSessionCredential("ses_1")

    await deps.storage.auth.users.create({
      id: "usr_1",
      projectId: sixb.id,
      email: "ava@acme.com",
    })
    // The caller must belong to a group to place a service account in it and to
    // manage that account's tokens afterwards.
    await deps.storage.auth.groupMemberships.upsert({
      projectId: sixb.id,
      userId: "usr_1",
      groupId: "commercial",
      source: "manual",
    })
    await deps.storage.auth.sessions.create({
      id: sessionCredential.sessionId,
      projectId: sixb.id,
      userId: "usr_1",
      strategyId: "test",
      audience: "atlas",
      tokenHash: sessionCredential.tokenHash,
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })
    const request = new Request("http://localhost/api/project", {
      headers: { cookie: `sixb_session=${sessionCredential.cookieValue}` },
    })

    const personal = await sixb.auth.createPersonalAccessToken(request, {
      name: "Local CLI",
      groupIds: [],
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })
    expect(personal.tokenValue).toStartWith("sixb_pat_tok_")
    expect(personal.accessToken).toMatchObject({
      kind: "personal",
      subjectType: "user",
      subjectId: "usr_1",
      groupIds: [],
    })

    const serviceAccount = await sixb.auth.createServiceAccount(request, {
      id: "svc_agent",
      name: "Sandbox agent",
      groupIds: ["commercial"],
    })
    expect(serviceAccount.serviceAccount).toMatchObject({
      id: "svc_agent",
      name: "Sandbox agent",
    })
    expect(serviceAccount.groupMemberships).toMatchObject([{ groupId: "commercial" }])

    const serviceToken = await sixb.auth.createServiceAccountAccessToken(request, {
      serviceAccountId: "svc_agent",
      name: "Agent token",
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })
    expect(serviceToken.tokenValue).toStartWith("sixb_sat_tok_")
    expect(serviceToken.accessToken).toMatchObject({
      kind: "serviceAccount",
      subjectType: "serviceAccount",
      subjectId: "svc_agent",
    })

    await sixb.auth.revokeServiceAccountAccessToken(request, {
      serviceAccountId: "svc_agent",
      tokenId: serviceToken.accessToken.id,
    })
    await expect(
      deps.storage.auth.accessTokens.findValidByTokenHash({
        projectId: sixb.id,
        id: serviceToken.accessToken.id,
        kind: "serviceAccount",
        tokenHash: serviceToken.accessToken.tokenHash,
        now: new Date("2026-05-16T10:01:00.000Z"),
      })
    ).resolves.toBeNull()
  })

  test("confines service account management to the caller's own groups", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({
      ontology: [],
      ...deps,
      auth: authStrategy,
    })
    const sessionCredential = createSessionCredential("ses_low")

    await deps.storage.auth.users.create({
      id: "usr_low",
      projectId: sixb.id,
      email: "low@acme.com",
    })
    await deps.storage.auth.groupMemberships.upsert({
      projectId: sixb.id,
      userId: "usr_low",
      groupId: "commercial",
      source: "manual",
    })
    await deps.storage.auth.sessions.create({
      id: sessionCredential.sessionId,
      projectId: sixb.id,
      userId: "usr_low",
      strategyId: "test",
      audience: "atlas",
      tokenHash: sessionCredential.tokenHash,
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })
    // A privileged service account in a group the caller does not belong to.
    await deps.storage.auth.serviceAccounts.create({
      id: "svc_priv",
      projectId: sixb.id,
      name: "Privileged worker",
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
    })
    await deps.storage.auth.serviceAccountGroupMemberships.upsert({
      projectId: sixb.id,
      serviceAccountId: "svc_priv",
      groupId: "finance",
      source: "manual",
    })
    const request = new Request("http://localhost/api/project", {
      headers: { cookie: `sixb_session=${sessionCredential.cookieValue}` },
    })

    // Cannot escalate a personal token or a new service account beyond the
    // caller's own groups.
    await expect(
      sixb.auth.createPersonalAccessToken(request, {
        name: "Escalated",
        groupIds: ["finance"],
        expiresAt: new Date("2099-05-16T10:00:00.000Z"),
      })
    ).rejects.toThrow("cannot be assigned")
    await expect(
      sixb.auth.createServiceAccount(request, { name: "Nope", groupIds: ["finance"] })
    ).rejects.toThrow("cannot be assigned")

    // Cannot mint, list, disable, or revoke tokens for a service account whose
    // groups it does not fully hold — reported as "not found" to avoid probing.
    await expect(
      sixb.auth.createServiceAccountAccessToken(request, {
        serviceAccountId: "svc_priv",
        name: "Stolen",
        expiresAt: new Date("2099-05-16T10:00:00.000Z"),
      })
    ).rejects.toThrow("not found")
    await expect(
      sixb.auth.listServiceAccountAccessTokens(request, { serviceAccountId: "svc_priv" })
    ).rejects.toThrow("not found")
    await expect(
      sixb.auth.disableServiceAccount(request, { serviceAccountId: "svc_priv" })
    ).rejects.toThrow("not found")

    // Listing hides the unmanageable account entirely.
    await expect(sixb.auth.listServiceAccounts(request)).resolves.toEqual({ serviceAccounts: [] })
  })

  test("resolves sessions and cookie names by audience", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({
      ontology: [],
      ...deps,
      auth: {
        strategy: authStrategy,
        cookies: {
          sessionCookieName: "acme_session",
          csrfCookieName: "acme_csrf",
        },
      },
    })
    const adminCredential = createSessionCredential("ses_admin")
    const appCredential = createSessionCredential("ses_app")

    await deps.storage.auth.users.create({
      id: "usr_1",
      projectId: sixb.id,
      email: "ava@acme.com",
    })
    await deps.storage.auth.sessions.create({
      id: adminCredential.sessionId,
      projectId: sixb.id,
      userId: "usr_1",
      strategyId: "test",
      audience: "atlas",
      tokenHash: adminCredential.tokenHash,
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })
    await deps.storage.auth.sessions.create({
      id: appCredential.sessionId,
      projectId: sixb.id,
      userId: "usr_1",
      strategyId: "test",
      audience: "app",
      tokenHash: appCredential.tokenHash,
      createdAt: new Date("2026-05-16T10:01:00.000Z"),
      expiresAt: new Date("2099-05-16T10:01:00.000Z"),
    })

    expect(sixb.auth.getCookieOptions({ audience: "atlas" })).toMatchObject({
      sessionCookieName: "acme_session",
      csrfCookieName: "acme_csrf",
    })
    expect(sixb.auth.getCookieOptions({ audience: "app" })).toMatchObject({
      sessionCookieName: "acme_session_app",
      csrfCookieName: "acme_csrf_app",
    })

    await expect(
      sixb.auth.getSession(
        new Request("http://localhost/api/project", {
          headers: { cookie: `acme_session_app=${appCredential.cookieValue}` },
        }),
        { audience: "app" }
      )
    ).resolves.toMatchObject({ authenticated: true, session: { id: "ses_app" } })
    await expect(
      sixb.auth.getSession(
        new Request("http://localhost/api/project", {
          headers: { cookie: `acme_session=${appCredential.cookieValue}` },
        }),
        { audience: "atlas" }
      )
    ).resolves.toEqual({ authenticated: false, reason: "invalid_session" })
    expect(() => sixb.auth.getCookieOptions({ audience: "app prod" as never })).toThrow(
      "Auth session audience 'app prod' is invalid"
    )
  })

  test("returns unauthenticated results for missing and suspended sessions", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({
      ontology: [],
      ...deps,
      auth: authStrategy,
    })
    const credential = createSessionCredential("ses_1")

    await deps.storage.auth.users.create({
      id: "usr_1",
      projectId: sixb.id,
      email: "ava@acme.com",
      status: "suspended",
    })
    await deps.storage.auth.sessions.create({
      id: credential.sessionId,
      projectId: sixb.id,
      userId: "usr_1",
      strategyId: "test",
      audience: "atlas",
      tokenHash: credential.tokenHash,
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })

    await expect(
      sixb.auth.getSession(new Request("http://localhost/api/project"))
    ).resolves.toEqual({ authenticated: false, reason: "missing_cookie" })
    await expect(
      sixb.auth.getSession(
        new Request("http://localhost/api/project", {
          headers: { cookie: `sixb_session=${credential.cookieValue}` },
        })
      )
    ).resolves.toEqual({ authenticated: false, reason: "suspended_user" })
  })

  test("creates security contexts with correlation ids", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({
      id: "project-a",
      ontology: [],
      ...deps,
      auth: authStrategy,
    })
    const credential = createSessionCredential("ses_1")

    await deps.storage.auth.users.create({
      id: "usr_1",
      projectId: sixb.id,
      email: "ava@acme.com",
    })
    await deps.storage.auth.sessions.create({
      id: credential.sessionId,
      projectId: sixb.id,
      userId: "usr_1",
      strategyId: "test",
      audience: "atlas",
      tokenHash: credential.tokenHash,
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })

    const context = await sixb.auth.createSecurityContext(
      new Request("http://localhost/api/project", {
        headers: {
          cookie: `sixb_session=${credential.cookieValue}`,
          "x-correlation-id": "corr_1",
        },
      })
    )

    expect(context).toEqual({
      principal: { type: "user", id: "usr_1" },
      sessionId: "ses_1",
      projectId: "project-a",
      correlationId: "corr_1",
    })
  })

  test("creates invitations with creator metadata and sends a magic link", async () => {
    const { deps, sixb, requests } = createInviteRuntime()
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupIds: ["security-admins"],
    })

    const result = await sixb.auth.invite(request, {
      email: " Ava@Acme.COM ",
      groups: [commercial],
      returnTo: "/objects?tab=all",
    })

    expect(result.delivery.status).toBe("sent")
    expect(result.invitation).toMatchObject({
      email: "ava@acme.com",
      groupIds: ["commercial"],
      status: "pending",
      createdByPrincipal: { type: "user", id: "usr_admin" },
      createdBySessionId: "ses_usr_admin",
    })
    expect(result.invitation.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      email: "ava@acme.com",
      returnTo: "/objects?tab=all",
    })
  })

  test("rejects undeliverable invitations before writing", async () => {
    const strategy: MagicLinkAuthStrategy = {
      id: "magic-link",
      kind: "magicLink" as const,
      async validateInvitationRecipient() {
        return { status: "disallowed_domain", email: "ava@example.com" }
      },
      async requestMagicLink(): Promise<never> {
        throw new Error("should not send")
      },
      async deliverInvitation(): Promise<never> {
        throw new Error("should not send")
      },
      async completeMagicLinkSignIn(): Promise<never> {
        throw new Error("unused")
      },
    }
    const { deps, sixb } = createInviteRuntime({ strategy })
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupIds: ["security-admins"],
    })

    await expect(
      sixb.auth.invite(request, {
        email: "ava@example.com",
        groups: [commercial],
      })
    ).rejects.toThrow("not allowed by the active auth strategy")
    await expect(deps.storage.auth.invitations.list({ projectId: sixb.id })).resolves.toMatchObject(
      { total: 0 }
    )
  })

  test("revokes invitations when magic-link delivery is not sent after creation", async () => {
    const strategy: MagicLinkAuthStrategy = {
      id: "magic-link",
      kind: "magicLink" as const,
      async requestMagicLink() {
        return { status: "skipped" as const }
      },
      async deliverInvitation() {
        return { status: "skipped" as const }
      },
      async completeMagicLinkSignIn(): Promise<never> {
        throw new Error("unused")
      },
    }
    const { deps, sixb } = createInviteRuntime({ strategy })
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupIds: ["security-admins"],
    })

    await expect(
      sixb.auth.invite(request, {
        email: "ava@acme.com",
        groups: [commercial],
      })
    ).rejects.toThrow("delivery was skipped")

    await expect(deps.storage.auth.invitations.list({ projectId: sixb.id })).resolves.toMatchObject(
      {
        total: 1,
        invitations: [{ email: "ava@acme.com", status: "revoked" }],
      }
    )
  })

  test("rejects invalid or unauthorized invitation input before writing", async () => {
    const { deps, sixb } = createInviteRuntime()
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupIds: ["security-admins"],
    })

    await expect(
      sixb.auth.invite(request, {
        email: "ava@acme.com",
        groups: [commercial],
        groupIds: ["commercial"],
      })
    ).rejects.toThrow("cannot provide both groups and groupIds")

    await expect(
      sixb.auth.invite(request, {
        email: "ava@acme.com",
        groups: [finance],
      })
    ).rejects.toThrow("not allowed")

    await expect(deps.storage.auth.invitations.list({ projectId: sixb.id })).resolves.toMatchObject(
      {
        total: 0,
      }
    )
  })

  test("lists and revokes invitations through membership policy scope", async () => {
    const { deps, sixb } = createInviteRuntime()
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupIds: ["security-admins"],
    })
    await deps.storage.auth.invitations.createOrUpdateActive({
      id: "inv_commercial",
      projectId: sixb.id,
      email: "commercial@acme.com",
      groupIds: ["commercial"],
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })
    await deps.storage.auth.invitations.createOrUpdateActive({
      id: "inv_finance",
      projectId: sixb.id,
      email: "finance@acme.com",
      groupIds: ["finance"],
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })
    await deps.storage.auth.invitations.createOrUpdateActive({
      id: "inv_empty",
      projectId: sixb.id,
      email: "empty@acme.com",
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })

    const list = await sixb.auth.listInvitations(request, { order: "asc" })

    expect(list.invitations.map((invitation) => invitation.id)).toEqual([
      "inv_commercial",
      "inv_empty",
    ])
    await expect(
      sixb.auth.revokeInvitation(request, { invitationId: "inv_finance" })
    ).rejects.toThrow("not allowed")
    await expect(
      sixb.auth.revokeInvitation(request, { invitationId: "inv_commercial" })
    ).resolves.toMatchObject({
      invitation: {
        id: "inv_commercial",
        status: "revoked",
      },
    })
  })

  test("does not revoke accepted invitations", async () => {
    const { deps, sixb } = createInviteRuntime()
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupIds: ["security-admins"],
    })
    await deps.storage.auth.invitations.createOrUpdateActive({
      id: "inv_accepted",
      projectId: sixb.id,
      email: "accepted@acme.com",
      groupIds: ["commercial"],
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })
    await deps.storage.auth.invitations.accept({
      projectId: sixb.id,
      id: "inv_accepted",
      acceptedAt: new Date("2026-05-16T10:00:00.000Z"),
    })

    await expect(
      sixb.auth.revokeInvitation(request, { invitationId: "inv_accepted" })
    ).rejects.toThrow("already accepted")
  })

  test("rejects magic-link bootstrap groups that are not registered", () => {
    const deps = createTestRuntimeDeps()
    const strategy: AuthStrategy = magicLinkStrategy

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [] as const,
          ...deps,
          auth: strategy,
        })
    ).toThrow("bootstrapGroups references unknown group 'missing-group'")
  })

  test("verifies double-submit CSRF tokens", () => {
    const request = new Request("http://localhost/api/objects", {
      method: "PUT",
      headers: {
        cookie: "sixb_csrf=csrf_1",
        "x-sixb-csrf": "csrf_1",
      },
    })

    expect(verifyDoubleSubmitCsrf(request, { cookieName: "sixb_csrf" })).toBe(true)
    expect(
      verifyDoubleSubmitCsrf(new Request("http://localhost/api/objects", { method: "PUT" }), {
        cookieName: "sixb_csrf",
      })
    ).toBe(false)
    expect(
      verifyDoubleSubmitCsrf(new Request("http://localhost/api/objects", { method: "GET" }), {
        cookieName: "sixb_csrf",
      })
    ).toBe(true)
  })

  test("caches resolved sessions and re-validates after invalidation", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({ ontology: [], ...deps, auth: authStrategy })
    const credential = createSessionCredential("ses_cache")
    await deps.storage.auth.users.create({
      id: "usr_1",
      projectId: sixb.id,
      email: "ava@acme.com",
    })
    await deps.storage.auth.sessions.create({
      id: credential.sessionId,
      projectId: sixb.id,
      userId: "usr_1",
      strategyId: "test",
      audience: "atlas",
      tokenHash: credential.tokenHash,
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })
    let findCalls = 0
    decorateOperationScopedMethodForTesting(
      deps.storage.auth.sessions,
      "findValidByTokenHash",
      (findValidByTokenHash) => async (input) => {
        findCalls += 1
        return findValidByTokenHash(input)
      }
    )
    const request = () =>
      new Request("http://localhost/api/project", {
        headers: { cookie: `sixb_session=${credential.cookieValue}` },
      })

    await expect(sixb.auth.getSession(request())).resolves.toMatchObject({ authenticated: true })
    await expect(sixb.auth.getSession(request())).resolves.toMatchObject({ authenticated: true })
    // Second resolution served from cache — storage hit only once.
    expect(findCalls).toBe(1)

    sixb.auth.invalidateSession(credential.sessionId)
    await expect(sixb.auth.getSession(request())).resolves.toMatchObject({ authenticated: true })
    expect(findCalls).toBe(2)
  })

  test("session cache is bound to the token secret, not just the session id", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({ ontology: [], ...deps, auth: authStrategy })
    const credential = createSessionCredential("ses_bind")
    await deps.storage.auth.users.create({
      id: "usr_1",
      projectId: sixb.id,
      email: "ava@acme.com",
    })
    await deps.storage.auth.sessions.create({
      id: credential.sessionId,
      projectId: sixb.id,
      userId: "usr_1",
      strategyId: "test",
      audience: "atlas",
      tokenHash: credential.tokenHash,
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })
    // Prime the cache with the valid cookie.
    await sixb.auth.getSession(
      new Request("http://localhost/api/project", {
        headers: { cookie: `sixb_session=${credential.cookieValue}` },
      })
    )

    // A forged cookie reusing the session id but a different secret must not hit the cache.
    const forged = formatSessionCookieValue(credential.sessionId, "wrong-secret")
    await expect(
      sixb.auth.getSession(
        new Request("http://localhost/api/project", {
          headers: { cookie: `sixb_session=${forged}` },
        })
      )
    ).resolves.toEqual({ authenticated: false, reason: "invalid_session" })
  })

  test("resolves sliding session policy defaults", () => {
    const session = resolveAuthConfig(undefined).session

    expect(session).toEqual({
      idleTimeoutMs: DEFAULT_AUTH_SESSION_IDLE_TIMEOUT_MS,
      renewalWindowMs: DEFAULT_AUTH_SESSION_RENEWAL_WINDOW_MS,
      cacheTtlMs: DEFAULT_AUTH_SESSION_CACHE_TTL_MS,
    })
    expect(session.absoluteTimeoutMs).toBeUndefined()
  })

  test("creates initial session deadlines from the configured policy", () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({
      ontology: [],
      ...deps,
      auth: {
        strategy: authStrategy,
        session: {
          idleTimeoutMs: 30_000,
          renewalWindowMs: 10_000,
          absoluteTimeoutMs: 90_000,
          cacheTtlMs: 1_000,
        },
      },
    })

    const now = new Date("2026-07-01T10:00:00.000Z")
    expect(sixb.auth.createSessionDeadlines(now)).toEqual({
      expiresAt: new Date(now.getTime() + 30_000),
      absoluteExpiresAt: new Date(now.getTime() + 90_000),
    })
  })

  test("does not retroactively add an absolute deadline to an existing session", async () => {
    const now = new Date("2026-07-01T10:00:00.000Z")
    setSystemTime(now)
    try {
      const deps = createTestRuntimeDeps()
      const sixb = new Sixb({
        ontology: [],
        ...deps,
        auth: {
          strategy: authStrategy,
          session: {
            idleTimeoutMs: 30 * 60_000,
            renewalWindowMs: 10 * 60_000,
            absoluteTimeoutMs: 60 * 60_000,
            cacheTtlMs: 0,
          },
        },
      })
      const credential = createSessionCredential("ses_existing_policy")
      await deps.storage.auth.users.create({
        id: "usr_existing_policy",
        projectId: sixb.id,
        email: "existing-policy@acme.com",
      })
      await deps.storage.auth.sessions.create({
        id: credential.sessionId,
        projectId: sixb.id,
        userId: "usr_existing_policy",
        strategyId: "test",
        audience: "atlas",
        tokenHash: credential.tokenHash,
        createdAt: new Date(now.getTime() - 2 * 60 * 60_000),
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      })
      const request = new Request("http://localhost/api/project", {
        headers: { cookie: `sixb_session=${credential.cookieValue}` },
      })

      const session = await sixb.auth.getSession(request, { sessionActivity: "foreground" })

      expect(session).toMatchObject({
        authenticated: true,
        sessionRenewed: true,
        session: {
          expiresAt: new Date(now.getTime() + 30 * 60_000),
        },
      })
      expect(session.authenticated && session.session.absoluteExpiresAt).toBeUndefined()
    } finally {
      setSystemTime()
    }
  })

  test("rejects invalid sliding session policy", () => {
    const cases: readonly [AuthSessionOptions, string][] = [
      [{ idleTimeoutMs: 0 }, "idleTimeoutMs must be a positive finite number"],
      [
        { idleTimeoutMs: 60_000, renewalWindowMs: 0 },
        "renewalWindowMs must be a positive finite number",
      ],
      [
        { idleTimeoutMs: 60_000, renewalWindowMs: 60_000 },
        "renewalWindowMs must be less than idleTimeoutMs",
      ],
      [{ absoluteTimeoutMs: 0 }, "absoluteTimeoutMs must be a positive finite number"],
      [
        { idleTimeoutMs: 60_000, renewalWindowMs: 10_000, absoluteTimeoutMs: 30_000 },
        "absoluteTimeoutMs must be greater than or equal to idleTimeoutMs",
      ],
      [
        { idleTimeoutMs: 60_000, renewalWindowMs: 10_000, cacheTtlMs: 10_000 },
        "cacheTtlMs must be less than renewalWindowMs",
      ],
    ]

    for (const [session, message] of cases) {
      expect(() => resolveAuthConfig({ strategy: authStrategy, session })).toThrow(message)
    }
  })

  test("renews a near-expiry session only for foreground activity", async () => {
    const now = new Date("2026-07-01T10:00:00.000Z")
    setSystemTime(now)
    try {
      const deps = createTestRuntimeDeps()
      const sixb = new Sixb({
        ontology: [],
        ...deps,
        auth: {
          strategy: authStrategy,
          session: {
            idleTimeoutMs: 30 * 60_000,
            renewalWindowMs: 10 * 60_000,
            cacheTtlMs: 0,
          },
        },
      })
      const credential = createSessionCredential("ses_renew")
      await deps.storage.auth.users.create({
        id: "usr_renew",
        projectId: sixb.id,
        email: "renew@acme.com",
      })
      await deps.storage.auth.sessions.create({
        id: credential.sessionId,
        projectId: sixb.id,
        userId: "usr_renew",
        strategyId: "test",
        audience: "atlas",
        tokenHash: credential.tokenHash,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      })
      let renewCalls = 0
      decorateOperationScopedMethodForTesting(
        deps.storage.auth.sessions,
        "renewIfValid",
        (renewIfValid) => async (input) => {
          renewCalls += 1
          return renewIfValid(input)
        }
      )
      const request = () =>
        new Request("http://localhost/api/project", {
          headers: { cookie: `sixb_session=${credential.cookieValue}` },
        })

      const background = await sixb.auth.getSession(request())
      expect(background).toMatchObject({ authenticated: true })
      expect(background.authenticated && background.sessionRenewed).toBeUndefined()
      expect(renewCalls).toBe(0)

      const foreground = await sixb.auth.getSession(request(), {
        sessionActivity: "foreground",
      })
      expect(foreground).toMatchObject({
        authenticated: true,
        sessionRenewed: true,
        session: { expiresAt: new Date(now.getTime() + 30 * 60_000) },
      })
      expect(renewCalls).toBe(1)
    } finally {
      setSystemTime()
    }
  })

  test("bypasses a cache hit at the renewal boundary and stops at the absolute cap", async () => {
    const now = new Date("2026-07-01T10:00:00.000Z")
    setSystemTime(now)
    try {
      const deps = createTestRuntimeDeps()
      const sixb = new Sixb({
        ontology: [],
        ...deps,
        auth: {
          strategy: authStrategy,
          session: {
            idleTimeoutMs: 30 * 60_000,
            renewalWindowMs: 10 * 60_000,
            absoluteTimeoutMs: 30 * 60_000,
            cacheTtlMs: 8 * 60_000,
          },
        },
      })
      const credential = createSessionCredential("ses_cached_renew")
      await deps.storage.auth.users.create({
        id: "usr_cached_renew",
        projectId: sixb.id,
        email: "cached-renew@acme.com",
      })
      await deps.storage.auth.sessions.create({
        id: credential.sessionId,
        projectId: sixb.id,
        userId: "usr_cached_renew",
        strategyId: "test",
        audience: "atlas",
        tokenHash: credential.tokenHash,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 12 * 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 60_000),
      })
      let findCalls = 0
      let renewCalls = 0
      decorateOperationScopedMethodForTesting(
        deps.storage.auth.sessions,
        "findValidByTokenHash",
        (findValidByTokenHash) => async (input) => {
          findCalls += 1
          return findValidByTokenHash(input)
        }
      )
      decorateOperationScopedMethodForTesting(
        deps.storage.auth.sessions,
        "renewIfValid",
        (renewIfValid) => async (input) => {
          renewCalls += 1
          return renewIfValid(input)
        }
      )
      const request = () =>
        new Request("http://localhost/api/project", {
          headers: { cookie: `sixb_session=${credential.cookieValue}` },
        })

      await sixb.auth.getSession(request(), { sessionActivity: "foreground" })
      expect(renewCalls).toBe(0)

      setSystemTime(new Date(now.getTime() + 2 * 60_000))
      const renewed = await sixb.auth.getSession(request(), { sessionActivity: "foreground" })
      expect(renewed).toMatchObject({
        authenticated: true,
        sessionRenewed: true,
        session: { expiresAt: new Date(now.getTime() + 30 * 60_000) },
      })
      expect(findCalls).toBe(2)
      expect(renewCalls).toBe(1)

      setSystemTime(new Date(now.getTime() + 21 * 60_000))
      const capped = await sixb.auth.getSession(request(), { sessionActivity: "foreground" })
      expect(capped.authenticated && capped.sessionRenewed).toBeUndefined()
      expect(renewCalls).toBe(1)
    } finally {
      setSystemTime()
    }
  })

  test("cacheTtlMs: 0 disables session caching", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({
      ontology: [],
      ...deps,
      auth: { strategy: authStrategy, session: { cacheTtlMs: 0 } },
    })
    const credential = createSessionCredential("ses_nocache")
    await deps.storage.auth.users.create({
      id: "usr_1",
      projectId: sixb.id,
      email: "ava@acme.com",
    })
    await deps.storage.auth.sessions.create({
      id: credential.sessionId,
      projectId: sixb.id,
      userId: "usr_1",
      strategyId: "test",
      audience: "atlas",
      tokenHash: credential.tokenHash,
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })
    let findCalls = 0
    decorateOperationScopedMethodForTesting(
      deps.storage.auth.sessions,
      "findValidByTokenHash",
      (findValidByTokenHash) => async (input) => {
        findCalls += 1
        return findValidByTokenHash(input)
      }
    )
    const request = () =>
      new Request("http://localhost/api/project", {
        headers: { cookie: `sixb_session=${credential.cookieValue}` },
      })

    await sixb.auth.getSession(request())
    await sixb.auth.getSession(request())
    expect(findCalls).toBe(2)
  })

  test("rejects invalid session cacheTtlMs", () => {
    const deps = createTestRuntimeDeps()
    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [] as const,
          ...deps,
          auth: { strategy: authStrategy, session: { cacheTtlMs: -1 } },
        })
    ).toThrow("cacheTtlMs must be a non-negative finite number")
  })

  test("serializes auth cookies with strict same-site defaults", () => {
    const options = resolveAuthCookieOptions(undefined)
    const request = new Request("http://localhost/api/auth/session")
    const expiresAt = new Date(Date.now() + 60_000)

    expect(
      createSessionCookieHeader({
        request,
        value: "ses_1.secret",
        expiresAt,
        options,
      })
    ).toContain("SameSite=Strict")
    expect(
      createCsrfCookieHeader({
        request,
        value: "csrf_1",
        expiresAt,
        options,
      })
    ).toContain("SameSite=Strict")
  })

  test("serializes auth cookie lifetime from the authoritative deadline", () => {
    const now = new Date("2026-07-01T10:00:00.500Z")
    const expiresAt = new Date("2026-07-01T10:01:00.000Z")
    setSystemTime(now)
    try {
      const header = createSessionCookieHeader({
        request: new Request("https://api.example.com/api/auth/session"),
        value: "ses_1.secret",
        expiresAt,
        options: resolveAuthCookieOptions(undefined),
      })

      expect(header).toContain("Max-Age=59")
      expect(header).toContain(`Expires=${expiresAt.toUTCString()}`)
      expect(
        createCsrfCookieHeader({
          request: new Request("https://api.example.com/api/auth/session"),
          value: "csrf_1",
          expiresAt: new Date(now.getTime() - 1),
          options: resolveAuthCookieOptions(undefined),
        })
      ).toContain("Max-Age=0")
      expect(() =>
        createSessionCookieHeader({
          request: new Request("https://api.example.com/api/auth/session"),
          value: "ses_1.secret",
          expiresAt: new Date(Number.NaN),
          options: resolveAuthCookieOptions(undefined),
        })
      ).toThrow("Auth cookie expiresAt must be a valid date")
    } finally {
      setSystemTime()
    }
  })

  test("supports HttpOnly CSRF cookies and validates host-prefixed cookie config", () => {
    const request = new Request("https://api.example.com/api/auth/session")
    const expiresAt = new Date(Date.now() + 60_000)
    const options = resolveAuthCookieOptions({
      sessionCookieName: "__Host-sixb_session",
      csrfCookieName: "__Host-sixb_csrf",
      csrfHttpOnly: true,
    })

    expect(
      createCsrfCookieHeader({
        request,
        value: "csrf_1",
        expiresAt,
        options,
      })
    ).toContain("HttpOnly")
    expect(
      createSessionCookieHeader({
        request,
        value: "ses_1.secret",
        expiresAt,
        options,
      })
    ).toContain("Secure")
    expect(() =>
      resolveAuthCookieOptions({
        sessionCookieName: "__Host-sixb_session",
        csrfCookieName: "__Host-sixb_csrf",
        cookieDomain: ".example.com",
      })
    ).toThrow("__Host- auth cookies cannot be configured with cookieDomain")
    expect(() =>
      resolveAuthCookieOptions({
        sessionCookieName: "__Host-sixb_session",
        csrfCookieName: "__Host-sixb_csrf",
        secure: false,
      })
    ).toThrow("__Host- auth cookies require secure cookies")
  })
})

function createMemberRuntime() {
  const deps = createTestRuntimeDeps()
  const sixb = new Sixb<readonly []>({
    id: "project-a",
    ontology: [] as const,
    ...deps,
    groups: [securityAdmins, commercial, finance, engineering],
    membershipPolicies: [
      defineMembershipPolicy("member-administration", {
        // Granted to commercial too so a caller can be both a policy holder and a
        // target within scope, which is what the self-protection tests exercise.
        grantedTo: [securityAdmins, commercial],
        scope: [commercial, finance],
        can: ["invite", "assignGroups", "suspend"],
      }),
    ],
    auth: authStrategy,
  })

  return { deps, sixb }
}

async function seedMember(
  deps: ReturnType<typeof createTestRuntimeDeps>,
  sixb: Sixb<readonly []>,
  params: {
    readonly userId: string
    readonly email: string
    readonly groupIds?: readonly string[]
    readonly status?: "active" | "suspended"
  }
): Promise<void> {
  await deps.storage.auth.users.create({
    id: params.userId,
    projectId: sixb.id,
    email: params.email,
    status: params.status,
  })
  for (const groupId of params.groupIds ?? []) {
    await deps.storage.auth.groupMemberships.upsert({
      projectId: sixb.id,
      userId: params.userId,
      groupId,
      source: "manual",
    })
  }
}

describe("Sixb auth member management", () => {
  test("membership options expose assignable groups and capabilities", async () => {
    const { deps, sixb } = createMemberRuntime()
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupIds: ["security-admins"],
    })

    const options = await sixb.auth.getMembershipOptions(request)

    expect(options.groups.map((group) => group.id).sort()).toEqual(["commercial", "finance"])
    expect(options.capabilities).toEqual({ invite: true, assignGroups: true, suspend: true })
  })

  test("lists members in scope, hides out-of-scope users, and includes group-less members", async () => {
    const { deps, sixb } = createMemberRuntime()
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupIds: ["security-admins"],
    })
    await seedMember(deps, sixb, {
      userId: "usr_commercial",
      email: "commercial@acme.com",
      groupIds: ["commercial"],
    })
    await seedMember(deps, sixb, { userId: "usr_groupless", email: "groupless@acme.com" })
    await seedMember(deps, sixb, {
      userId: "usr_out",
      email: "out@acme.com",
      groupIds: ["engineering"],
    })
    // A member with any out-of-scope group is out of scope as a whole.
    await seedMember(deps, sixb, {
      userId: "usr_mixed",
      email: "mixed@acme.com",
      groupIds: ["commercial", "engineering"],
    })

    const list = await sixb.auth.listMembers(request, { order: "asc" })
    const ids = list.members.map((member) => member.user.id)

    expect(ids).toContain("usr_commercial")
    expect(ids).toContain("usr_groupless")
    expect(ids).not.toContain("usr_out")
    expect(ids).not.toContain("usr_mixed")
    // The admin's own group (security-admins) is out of scope, so they are not listed.
    expect(ids).not.toContain("usr_admin")
    expect(list.total).toBe(ids.length)
  })

  test("member capabilities reflect status and self-protection", async () => {
    const { deps, sixb } = createMemberRuntime()
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_self",
      email: "self@acme.com",
      groupIds: ["commercial"],
    })
    await seedMember(deps, sixb, {
      userId: "usr_active",
      email: "active@acme.com",
      groupIds: ["finance"],
    })
    await seedMember(deps, sixb, {
      userId: "usr_suspended",
      email: "suspended@acme.com",
      groupIds: ["finance"],
      status: "suspended",
    })

    const list = await sixb.auth.listMembers(request, { order: "asc" })
    const capabilities = new Map(
      list.members.map((member) => [member.user.id, member.capabilities])
    )

    expect(capabilities.get("usr_self")).toEqual({
      assignGroups: true,
      suspend: false,
      reactivate: false,
    })
    expect(capabilities.get("usr_active")).toEqual({
      assignGroups: true,
      suspend: true,
      reactivate: false,
    })
    expect(capabilities.get("usr_suspended")).toEqual({
      assignGroups: true,
      suspend: false,
      reactivate: true,
    })
  })

  test("assigns and removes a member's groups within scope", async () => {
    const { deps, sixb } = createMemberRuntime()
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupIds: ["security-admins"],
    })
    await seedMember(deps, sixb, {
      userId: "usr_target",
      email: "target@acme.com",
      groupIds: ["commercial"],
    })

    const result = await sixb.auth.updateMemberGroups(request, {
      userId: "usr_target",
      groupIds: ["finance"],
    })

    expect(result.groupIds).toEqual(["finance"])
    await expect(
      deps.storage.auth.groupMemberships.listForUser({ projectId: sixb.id, userId: "usr_target" })
    ).resolves.toMatchObject([{ groupId: "finance", source: "manual" }])
  })

  test("rejects group assignment outside scope and unknown groups", async () => {
    const { deps, sixb } = createMemberRuntime()
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupIds: ["security-admins"],
    })
    await seedMember(deps, sixb, {
      userId: "usr_target",
      email: "target@acme.com",
      groupIds: ["commercial"],
    })

    await expect(
      sixb.auth.updateMemberGroups(request, { userId: "usr_target", groupIds: ["engineering"] })
    ).rejects.toThrow("not allowed to assign")
    await expect(
      sixb.auth.updateMemberGroups(request, { userId: "usr_target", groupIds: ["ghost"] })
    ).rejects.toThrow("Unknown group")
  })

  test("treats out-of-scope and missing targets identically", async () => {
    const { deps, sixb } = createMemberRuntime()
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupIds: ["security-admins"],
    })
    await seedMember(deps, sixb, {
      userId: "usr_out",
      email: "out@acme.com",
      groupIds: ["engineering"],
    })

    await expect(
      sixb.auth.updateMemberGroups(request, { userId: "usr_out", groupIds: ["commercial"] })
    ).rejects.toThrow("not found")
    await expect(sixb.auth.suspendMember(request, { userId: "usr_missing" })).rejects.toThrow(
      "not found"
    )
  })

  test("blocks removing your own groups but allows adding in-scope groups", async () => {
    const { deps, sixb } = createMemberRuntime()
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_self",
      email: "self@acme.com",
      groupIds: ["commercial"],
    })

    await expect(
      sixb.auth.updateMemberGroups(request, { userId: "usr_self", groupIds: [] })
    ).rejects.toThrow("cannot remove their own groups")

    const result = await sixb.auth.updateMemberGroups(request, {
      userId: "usr_self",
      groupIds: ["commercial", "finance"],
    })
    expect([...result.groupIds].sort()).toEqual(["commercial", "finance"])
  })

  test("suspends and reactivates an in-scope member and stops their sessions", async () => {
    const { deps, sixb } = createMemberRuntime()
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_admin",
      email: "admin@acme.com",
      groupIds: ["security-admins"],
    })
    const targetCredential = createSessionCredential("ses_target")
    await deps.storage.auth.users.create({
      id: "usr_target",
      projectId: sixb.id,
      email: "target@acme.com",
    })
    await deps.storage.auth.groupMemberships.upsert({
      projectId: sixb.id,
      userId: "usr_target",
      groupId: "commercial",
      source: "manual",
    })
    await deps.storage.auth.sessions.create({
      id: targetCredential.sessionId,
      projectId: sixb.id,
      userId: "usr_target",
      strategyId: "test",
      audience: "atlas",
      tokenHash: targetCredential.tokenHash,
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })
    const targetRequest = () =>
      new Request("http://localhost/api/project", {
        headers: { cookie: `sixb_session=${targetCredential.cookieValue}` },
      })

    // The target's session authenticates and is cached before suspension.
    await expect(sixb.auth.getSession(targetRequest())).resolves.toMatchObject({
      authenticated: true,
    })

    const suspended = await sixb.auth.suspendMember(request, { userId: "usr_target" })
    expect(suspended.user.status).toBe("suspended")
    expect(suspended.groupIds).toEqual(["commercial"])

    // Suspension revokes sessions and drops the cached entry, so the target no
    // longer authenticates.
    await expect(sixb.auth.getSession(targetRequest())).resolves.toMatchObject({
      authenticated: false,
      reason: "invalid_session",
    })

    const reactivated = await sixb.auth.reactivateMember(request, { userId: "usr_target" })
    expect(reactivated.user.status).toBe("active")
    // Reactivation does not restore sessions.
    await expect(sixb.auth.getSession(targetRequest())).resolves.toMatchObject({
      authenticated: false,
    })
  })

  test("blocks suspending yourself", async () => {
    const { deps, sixb } = createMemberRuntime()
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_self",
      email: "self@acme.com",
      groupIds: ["commercial"],
    })

    // Coverage is not authorization, and this is the case that proves it: the caller's policy scope
    // reaches its own group, so the capability query answers `true`, and the operation still refuses.
    // That gap is why the query is named `covers` rather than `can`.
    const capabilities = sixb.auth.getMembershipCapabilities({ callerGroups: [commercial] })
    expect(capabilities.covers("suspend", [commercial])).toBe(true)
    // A session hands ids, not definitions, so both forms have to answer the same thing.
    expect(capabilities.covers("suspend", [commercial.id])).toBe(true)

    await expect(sixb.auth.suspendMember(request, { userId: "usr_self" })).rejects.toThrow(
      "cannot suspend themselves"
    )
  })

  test("a caller without a membership policy manages nobody", async () => {
    const { deps, sixb } = createMemberRuntime()
    const request = await seedAuthenticatedUser(sixb, deps, {
      userId: "usr_plain",
      email: "plain@acme.com",
      groupIds: ["finance"],
    })
    await seedMember(deps, sixb, {
      userId: "usr_target",
      email: "target@acme.com",
      groupIds: ["commercial"],
    })

    const options = await sixb.auth.getMembershipOptions(request)
    expect(options.capabilities).toEqual({ invite: false, assignGroups: false, suspend: false })
    await expect(sixb.auth.listMembers(request)).resolves.toMatchObject({ members: [], total: 0 })
    await expect(sixb.auth.suspendMember(request, { userId: "usr_target" })).rejects.toThrow(
      "not found"
    )
  })
})
