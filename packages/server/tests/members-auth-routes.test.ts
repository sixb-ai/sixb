import { describe, expect, test } from "bun:test"
import { magicLink } from "@sixb/auth-magic-link"
import {
  agent,
  can,
  defineGroup,
  defineMembershipPolicy,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type MembershipPolicyDefinition,
  project,
  prop,
  type RoleDefinition,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createSixbApi, SixbServer } from "../src/server"
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

function createRuntime(
  options: {
    readonly membershipPolicies?: readonly MembershipPolicyDefinition[]
    readonly roles?: readonly RoleDefinition[]
  } = {}
) {
  const storage = new InMemoryStorage()
  const sixb = new SixbHost({
    id: projectId,
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    groups: [securityAdmins, commercial, finance],
    membershipPolicies: options.membershipPolicies ?? [defaultMembershipPolicy()],
    roles: options.roles,
    auth: magicLink({
      allowedDomains: ["acme.com"],
      async sendMagicLink() {},
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
    sixb,
    storage,
  }
}

function defaultMembershipPolicy(): MembershipPolicyDefinition {
  return defineMembershipPolicy("member-administration", {
    // Commercial is included so route-level self-protection can be exercised by
    // a caller whose own current groups are also inside the policy scope.
    grantedTo: [securityAdmins, commercial],
    scope: [commercial],
    can: ["invite", "assignGroups", "suspend"],
  })
}

async function seedSession(
  storage: InMemoryStorage,
  params: {
    readonly userId: string
    readonly sessionId?: string
    readonly csrfToken?: string
  }
) {
  const credential = createSessionCredential(params.sessionId ?? `ses_${params.userId}`)
  const csrfToken = params.csrfToken ?? `csrf_${params.userId}`
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId,
    userId: params.userId,
    strategyId: "magic-link",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-17T10:00:00.000Z"),
    expiresAt: new Date("2099-05-17T10:00:00.000Z"),
  })

  return {
    cookie: `sixb_session_app=${credential.cookieValue}; sixb_csrf_app=${csrfToken}`,
    csrfHeader: { "x-sixb-csrf": csrfToken },
  }
}

async function seedUser(
  storage: InMemoryStorage,
  params: {
    readonly id: string
    readonly email?: string
    readonly groupIds?: readonly string[]
    readonly status?: "active" | "suspended"
    readonly createdAt?: string
  }
) {
  await storage.auth.users.create({
    id: params.id,
    projectId,
    email: params.email ?? `${params.id}@acme.com`,
    status: params.status,
    createdAt: params.createdAt ? new Date(params.createdAt) : undefined,
  })
  for (const groupId of params.groupIds ?? []) {
    await storage.auth.groupMemberships.upsert({
      projectId,
      userId: params.id,
      groupId,
      source: "manual",
    })
  }
}

async function seedAdminSession(storage: InMemoryStorage) {
  await seedUser(storage, {
    id: "usr_admin",
    email: "admin@acme.com",
    groupIds: ["security-admins"],
    createdAt: "2026-05-17T10:00:00.000Z",
  })
  return seedSession(storage, { userId: "usr_admin", sessionId: "ses_admin", csrfToken: "csrf_1" })
}

function jsonRequest(
  path: string,
  init: {
    readonly method?: string
    readonly cookie?: string
    readonly csrfHeader?: Record<string, string>
    readonly body?: unknown
  } = {}
): Request {
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.csrfHeader ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

describe("auth member routes", () => {
  // The app opens the Console and lists Settings › Members and Service accounts from this, so a
  // person never opens a page the policies and grants keep them from using. Reproduce: send
  // `access` as all true from authSessionBody.
  test("the session says whether a person may open the Console and each Settings project page", async () => {
    const sessionAccess = async (app: ReturnType<typeof createRuntime>["app"], cookie: string) => {
      const response = await app.handle(jsonRequest("/api/auth/session", { cookie }))
      expect(response.status).toBe(200)
      return ((await response.json()) as { readonly access: unknown }).access
    }

    const { app, storage } = createRuntime()
    const admin = await seedAdminSession(storage)
    await seedUser(storage, { id: "usr_groupless", email: "groupless@acme.com" })
    const groupless = await seedSession(storage, { userId: "usr_groupless" })
    const none = {
      console: false,
      logs: false,
      members: false,
      serviceAccounts: false,
      usage: false,
      activity: false,
    }
    expect(await sessionAccess(app, admin.cookie)).toEqual({ ...none, members: true })
    expect(await sessionAccess(app, groupless.cookie)).toEqual(none)

    const withServiceAccounts = createRuntime({
      membershipPolicies: [
        defineMembershipPolicy("service-accounts", {
          grantedTo: [securityAdmins],
          scope: [finance],
          can: ["serviceAccounts"],
        }),
      ],
    })
    const serviceAdmin = await seedAdminSession(withServiceAccounts.storage)
    expect(await sessionAccess(withServiceAccounts.app, serviceAdmin.cookie)).toEqual({
      ...none,
      serviceAccounts: true,
    })

    // The Console, Logs, Usage and Activity follow grants.
    const observing = createRuntime({
      membershipPolicies: [],
      roles: [
        defineRole("observer", {
          grantedTo: [finance],
          grants: [
            can.observe(agent.usage),
            can.observe(project.activity),
            can.observe(project.console),
            can.observe(project.logs),
          ],
        }),
      ],
    })
    await seedUser(observing.storage, { id: "usr_finance", groupIds: ["finance"] })
    const observer = await seedSession(observing.storage, { userId: "usr_finance" })
    expect(await sessionAccess(observing.app, observer.cookie)).toEqual({
      ...none,
      usage: true,
      activity: true,
      console: true,
      logs: true,
    })
  })

  test("lists scoped members and returns membership options", async () => {
    const { app, storage } = createRuntime()
    const admin = await seedAdminSession(storage)
    await seedUser(storage, {
      id: "usr_commercial",
      email: "commercial@acme.com",
      groupIds: ["commercial"],
      createdAt: "2026-05-17T10:01:00.000Z",
    })
    await seedUser(storage, {
      id: "usr_groupless",
      email: "groupless@acme.com",
      createdAt: "2026-05-17T10:02:00.000Z",
    })
    await seedUser(storage, {
      id: "usr_finance",
      email: "finance@acme.com",
      groupIds: ["finance"],
      createdAt: "2026-05-17T10:03:00.000Z",
    })

    const options = await app.fetch(
      jsonRequest("/api/auth/membership-options", { cookie: admin.cookie })
    )
    // A session that has ended still says when they were last here; usr_groupless never signed in.
    await storage.auth.sessions.create({
      id: "ses_commercial",
      projectId,
      userId: "usr_commercial",
      strategyId: "magic-link",
      tokenHash: "hash_commercial",
      createdAt: new Date("2026-05-18T09:00:00.000Z"),
      expiresAt: new Date("2026-05-19T09:00:00.000Z"),
    })
    await storage.auth.sessions.touch({
      projectId,
      id: "ses_commercial",
      lastSeenAt: new Date("2026-05-18T16:30:00.000Z"),
    })
    const list = await app.fetch(
      jsonRequest("/api/auth/members?order=asc", { cookie: admin.cookie })
    )
    const body = (await list.json()) as {
      readonly members: readonly {
        readonly lastActiveAt?: string
        readonly user: { readonly id: string; readonly status: string }
        readonly groupIds: readonly string[]
        readonly capabilities: {
          readonly assignGroups: boolean
          readonly suspend: boolean
          readonly reactivate: boolean
        }
      }[]
      readonly total: number
    }

    expect(options.status).toBe(200)
    expect(await options.json()).toEqual({
      groups: [{ id: "commercial" }],
      serviceAccountGroups: [],
      capabilities: { invite: true, assignGroups: true, suspend: true, serviceAccounts: false },
    })
    expect(list.status).toBe(200)
    expect(body.members.map((member) => member.user.id)).toEqual([
      "usr_commercial",
      "usr_groupless",
    ])
    expect(body.members[0]).toMatchObject({
      groupIds: ["commercial"],
      capabilities: { assignGroups: true, suspend: true, reactivate: false },
      lastActiveAt: "2026-05-18T16:30:00.000Z",
    })
    expect(body.members[1]).toMatchObject({
      groupIds: [],
      capabilities: { assignGroups: true, suspend: true, reactivate: false },
    })
    expect(body.members[1]?.lastActiveAt).toBeUndefined()
    expect(body.total).toBe(2)
  })

  test("updates groups and maps out-of-scope access to the right statuses", async () => {
    const { app, storage } = createRuntime()
    const admin = await seedAdminSession(storage)
    await seedUser(storage, { id: "usr_target", groupIds: ["commercial"] })
    await seedUser(storage, { id: "usr_finance", groupIds: ["finance"] })

    const update = await app.fetch(
      jsonRequest("/api/auth/members/usr_target/groups", {
        method: "PATCH",
        cookie: admin.cookie,
        csrfHeader: admin.csrfHeader,
        body: { groupIds: [] },
      })
    )
    const requestedOutOfScope = await app.fetch(
      jsonRequest("/api/auth/members/usr_target/groups", {
        method: "PATCH",
        cookie: admin.cookie,
        csrfHeader: admin.csrfHeader,
        body: { groupIds: ["finance"] },
      })
    )
    const unknownGroup = await app.fetch(
      jsonRequest("/api/auth/members/usr_target/groups", {
        method: "PATCH",
        cookie: admin.cookie,
        csrfHeader: admin.csrfHeader,
        body: { groupIds: ["ghost"] },
      })
    )
    const outOfScopeTarget = await app.fetch(
      jsonRequest("/api/auth/members/usr_finance/groups", {
        method: "PATCH",
        cookie: admin.cookie,
        csrfHeader: admin.csrfHeader,
        body: { groupIds: ["commercial"] },
      })
    )
    const missingTarget = await app.fetch(
      jsonRequest("/api/auth/members/usr_missing/suspend", {
        method: "POST",
        cookie: admin.cookie,
        csrfHeader: admin.csrfHeader,
      })
    )

    expect(update.status).toBe(200)
    expect(await update.json()).toMatchObject({
      member: {
        user: { id: "usr_target", status: "active" },
        groupIds: [],
      },
    })
    await expect(
      storage.auth.groupMemberships.listForUser({ projectId, userId: "usr_target" })
    ).resolves.toEqual([])
    expect(requestedOutOfScope.status).toBe(403)
    expect(unknownGroup.status).toBe(400)
    expect(outOfScopeTarget.status).toBe(404)
    expect(missingTarget.status).toBe(404)
  })

  test("reports and keeps the groups the identity provider manages", async () => {
    const { app, storage } = createRuntime()
    const admin = await seedAdminSession(storage)
    await seedUser(storage, { id: "usr_target" })
    await storage.auth.groupMemberships.upsert({
      projectId,
      userId: "usr_target",
      groupId: "commercial",
      source: "directory",
    })

    const list = await app.fetch(jsonRequest("/api/auth/members", { cookie: admin.cookie }))
    const removeManaged = await app.fetch(
      jsonRequest("/api/auth/members/usr_target/groups", {
        method: "PATCH",
        cookie: admin.cookie,
        csrfHeader: admin.csrfHeader,
        body: { groupIds: [] },
      })
    )
    const keepManaged = await app.fetch(
      jsonRequest("/api/auth/members/usr_target/groups", {
        method: "PATCH",
        cookie: admin.cookie,
        csrfHeader: admin.csrfHeader,
        body: { groupIds: ["commercial"] },
      })
    )

    expect(await list.json()).toMatchObject({
      members: [
        { user: { id: "usr_target" }, groupIds: ["commercial"], managedGroupIds: ["commercial"] },
      ],
    })
    // Removing it here would only last until the member's next sign-in restored it.
    expect(removeManaged.status).toBe(400)
    expect(await removeManaged.json()).toMatchObject({
      error: expect.stringContaining("managed by the identity provider"),
    })
    expect(keepManaged.status).toBe(200)
    expect(await keepManaged.json()).toMatchObject({
      member: { groupIds: ["commercial"], managedGroupIds: ["commercial"] },
    })
    await expect(
      storage.auth.groupMemberships.listForUser({ projectId, userId: "usr_target" })
    ).resolves.toMatchObject([{ groupId: "commercial", source: "directory" }])
  })

  test("suspends and reactivates members without restoring revoked sessions", async () => {
    const { app, storage } = createRuntime()
    const admin = await seedAdminSession(storage)
    await seedUser(storage, {
      id: "usr_target",
      email: "target@acme.com",
      groupIds: ["commercial"],
    })
    const target = await seedSession(storage, {
      userId: "usr_target",
      sessionId: "ses_target",
      csrfToken: "csrf_target",
    })

    const sessionBefore = await app.fetch(
      jsonRequest("/api/auth/session", { cookie: target.cookie })
    )
    const suspend = await app.fetch(
      jsonRequest("/api/auth/members/usr_target/suspend", {
        method: "POST",
        cookie: admin.cookie,
        csrfHeader: admin.csrfHeader,
      })
    )
    const sessionAfterSuspend = await app.fetch(
      jsonRequest("/api/auth/session", { cookie: target.cookie })
    )
    const reactivate = await app.fetch(
      jsonRequest("/api/auth/members/usr_target/reactivate", {
        method: "POST",
        cookie: admin.cookie,
        csrfHeader: admin.csrfHeader,
      })
    )
    const sessionAfterReactivate = await app.fetch(
      jsonRequest("/api/auth/session", { cookie: target.cookie })
    )

    expect(sessionBefore.status).toBe(200)
    expect(await sessionBefore.json()).toMatchObject({ authenticated: true })
    expect(suspend.status).toBe(200)
    expect(await suspend.json()).toMatchObject({
      member: { user: { id: "usr_target", status: "suspended" }, groupIds: ["commercial"] },
    })
    expect(await sessionAfterSuspend.json()).toEqual({ authenticated: false, authEnabled: true })
    expect(reactivate.status).toBe(200)
    expect(await reactivate.json()).toMatchObject({
      member: { user: { id: "usr_target", status: "active" }, groupIds: ["commercial"] },
    })
    expect(await sessionAfterReactivate.json()).toEqual({ authenticated: false, authEnabled: true })
  })

  test("enforces self-protection", async () => {
    const { app, storage } = createRuntime()
    await seedUser(storage, { id: "usr_self", email: "self@acme.com", groupIds: ["commercial"] })
    const self = await seedSession(storage, {
      userId: "usr_self",
      sessionId: "ses_self",
      csrfToken: "csrf_self",
    })

    const removeOwnGroups = await app.fetch(
      jsonRequest("/api/auth/members/usr_self/groups", {
        method: "PATCH",
        cookie: self.cookie,
        csrfHeader: self.csrfHeader,
        body: { groupIds: [] },
      })
    )
    const suspendSelf = await app.fetch(
      jsonRequest("/api/auth/members/usr_self/suspend", {
        method: "POST",
        cookie: self.cookie,
        csrfHeader: self.csrfHeader,
      })
    )

    expect(removeOwnGroups.status).toBe(403)
    expect(await removeOwnGroups.json()).toEqual({
      error: "[Sixb] The current user cannot remove their own groups.",
    })
    expect(suspendSelf.status).toBe(403)
    expect(await suspendSelf.json()).toEqual({
      error: "[Sixb] The current user cannot suspend themselves.",
    })
  })
})
