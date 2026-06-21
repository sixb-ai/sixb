import { describe, expect, spyOn, test } from "bun:test"
import {
  type AuthStrategy,
  createAccessTokenCredential,
  createCsrfCookieHeader,
  createSessionCookieHeader,
  createSessionCredential,
  defineGroup,
  defineInvitePolicy,
  formatSessionCookieValue,
  hashSessionSecret,
  type MagicLinkAuthStrategy,
  parseSessionCookieValue,
  resolveAuthCookieOptions,
  Sixb,
  verifyDoubleSubmitCsrf,
} from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const authStrategy = {
  id: "test",
  kind: "dev" as const,
}

const securityAdmins = defineGroup("security-admins")
const commercial = defineGroup("commercial")
const finance = defineGroup("finance")

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
    invitePolicies: [
      defineInvitePolicy("default-invites", {
        grantedTo: [securityAdmins],
        canInviteTo: [commercial],
        canInviteWithoutGroups: true,
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

    await sixb.auth.revokeAccessToken(request, { tokenId: serviceToken.accessToken.id })
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
    expect(() => sixb.auth.getCookieOptions({ audience: "app prod" })).toThrow(
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

  test("lists and revokes invitations through invite policy scope", async () => {
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
    const spy = spyOn(deps.storage.auth.sessions, "findValidByTokenHash")
    const request = () =>
      new Request("http://localhost/api/project", {
        headers: { cookie: `sixb_session=${credential.cookieValue}` },
      })

    await expect(sixb.auth.getSession(request())).resolves.toMatchObject({ authenticated: true })
    await expect(sixb.auth.getSession(request())).resolves.toMatchObject({ authenticated: true })
    // Second resolution served from cache — storage hit only once.
    expect(spy).toHaveBeenCalledTimes(1)

    sixb.auth.invalidateSession(credential.sessionId)
    await expect(sixb.auth.getSession(request())).resolves.toMatchObject({ authenticated: true })
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
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
    const spy = spyOn(deps.storage.auth.sessions, "findValidByTokenHash")
    const request = () =>
      new Request("http://localhost/api/project", {
        headers: { cookie: `sixb_session=${credential.cookieValue}` },
      })

    await sixb.auth.getSession(request())
    await sixb.auth.getSession(request())
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
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

    expect(
      createSessionCookieHeader({
        request,
        value: "ses_1.secret",
        maxAgeSeconds: 60,
        options,
      })
    ).toContain("SameSite=Strict")
    expect(
      createCsrfCookieHeader({
        request,
        value: "csrf_1",
        maxAgeSeconds: 60,
        options,
      })
    ).toContain("SameSite=Strict")
  })

  test("supports HttpOnly CSRF cookies and validates host-prefixed cookie config", () => {
    const request = new Request("https://api.example.com/api/auth/session")
    const options = resolveAuthCookieOptions({
      sessionCookieName: "__Host-sixb_session",
      csrfCookieName: "__Host-sixb_csrf",
      csrfHttpOnly: true,
    })

    expect(
      createCsrfCookieHeader({
        request,
        value: "csrf_1",
        maxAgeSeconds: 60,
        options,
      })
    ).toContain("HttpOnly")
    expect(
      createSessionCookieHeader({
        request,
        value: "ses_1.secret",
        maxAgeSeconds: 60,
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
