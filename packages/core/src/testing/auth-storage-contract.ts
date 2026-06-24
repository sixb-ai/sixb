import { describe, expect, test } from "bun:test"
import type {
  AuthStorage,
  AuthStorageErrorCode,
  CompleteAuthSessionInput,
  UserRecord,
} from "../storage/auth"
import { AuthStorageError } from "../storage/auth"

export interface AuthStorageContractSuiteOptions<TStorage extends AuthStorage = AuthStorage> {
  /** Factory that produces a fresh `AuthStorage` instance for each test case. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  /** Optional cleanup invoked after every test case. */
  readonly teardown?: (storage: TStorage) => void | Promise<void>
}

const projectId = "project-a"
const otherProjectId = "project-b"

function at(value: string): Date {
  return new Date(value)
}

function sessionInput(
  id: string,
  tokenHash = `${id}-hash`,
  audience: CompleteAuthSessionInput["audience"] = "atlas"
): CompleteAuthSessionInput {
  return {
    id,
    audience,
    tokenHash,
    createdAt: at("2026-05-14T10:10:00.000Z"),
    expiresAt: at("2026-05-21T10:10:00.000Z"),
  }
}

async function expectAuthError(
  promise: Promise<unknown>,
  code: AuthStorageErrorCode
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AuthStorageError)
  await expect(promise).rejects.toMatchObject({ code })
}

async function createUser(
  storage: AuthStorage,
  input: {
    readonly id?: string
    readonly email?: string
    readonly status?: UserRecord["status"]
    readonly projectId?: string
  } = {}
): Promise<UserRecord> {
  return storage.users.create({
    id: input.id ?? "usr_1",
    projectId: input.projectId ?? projectId,
    email: input.email ?? "ava@acme.com",
    status: input.status,
    createdAt: at("2026-05-14T10:00:00.000Z"),
  })
}

/**
 * Runs the shared `AuthStorage` contract against any storage implementation.
 *
 * The suite is the storage-independent specification for Sixb auth state: users, identities,
 * sessions, invitations, group memberships, service accounts, access tokens,
 * magic links, OIDC attempts, and atomic sign-in completion.
 */
export function runAuthStorageContractSuite<TStorage extends AuthStorage>(
  label: string,
  options: AuthStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await body(storage)
    } finally {
      await options.teardown?.(storage)
    }
  }

  describe(label, () => {
    test("creates users with normalized email and isolates projects", async () => {
      await withStorage(async (storage) => {
        const user = await createUser(storage, {
          email: " Ava@Acme.COM ",
        })

        expect(user.email).toBe("ava@acme.com")
        await expectAuthError(
          storage.users.create({
            id: "usr_duplicate",
            projectId,
            email: "ava@acme.com",
            createdAt: at("2026-05-14T10:01:00.000Z"),
          }),
          "duplicate_user"
        )

        await expect(
          storage.users.create({
            id: "usr_other",
            projectId: otherProjectId,
            email: "ava@acme.com",
            createdAt: at("2026-05-14T10:02:00.000Z"),
          })
        ).resolves.toMatchObject({
          projectId: otherProjectId,
          email: "ava@acme.com",
        })

        const page = await storage.users.list({ projectId, statuses: ["active"] })
        expect(page.users.map((row) => row.id)).toEqual(["usr_1"])
      })
    })

    test("upserts identities without mutating canonical user email", async () => {
      await withStorage(async (storage) => {
        await createUser(storage, { id: "usr_oidc", email: "ava@acme.com" })

        await storage.identities.upsert({
          projectId,
          strategyId: "okta",
          subject: "00u1",
          userId: "usr_oidc",
          claims: { email: "ava@acme.com" },
          createdAt: at("2026-05-14T10:01:00.000Z"),
        })
        const updated = await storage.identities.upsert({
          projectId,
          strategyId: "okta",
          subject: "00u1",
          userId: "usr_oidc",
          claims: { email: "ava.renamed@acme.com" },
          updatedAt: at("2026-05-14T10:02:00.000Z"),
        })

        expect(updated.claims).toEqual({ email: "ava.renamed@acme.com" })
        await expect(storage.users.getById({ projectId, id: "usr_oidc" })).resolves.toMatchObject({
          email: "ava@acme.com",
        })
      })
    })

    test("keeps multiple concurrent sessions per user and never extends expiry on touch", async () => {
      await withStorage(async (storage) => {
        await createUser(storage)

        const first = await storage.sessions.create({
          id: "ses_1",
          projectId,
          userId: "usr_1",
          strategyId: "magic-link",
          audience: "atlas",
          tokenHash: "hash-1",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-21T10:00:00.000Z"),
        })
        const second = await storage.sessions.create({
          id: "ses_2",
          projectId,
          userId: "usr_1",
          strategyId: "magic-link",
          audience: "atlas",
          tokenHash: "hash-2",
          createdAt: at("2026-05-14T10:05:00.000Z"),
          expiresAt: at("2026-05-21T10:05:00.000Z"),
        })

        // Creating a second session in the same audience no longer revokes the
        // first: both stay active and authenticate independently.
        expect(first.revokedAt).toBeUndefined()
        expect(second.revokedAt).toBeUndefined()
        const storedFirst = await storage.sessions.getById({ projectId, id: "ses_1" })
        expect(storedFirst?.revokedAt).toBeUndefined()

        await expect(
          storage.sessions.findValidByTokenHash({
            projectId,
            id: "ses_1",
            audience: "atlas",
            tokenHash: "hash-1",
            now: at("2026-05-14T10:06:00.000Z"),
          })
        ).resolves.toMatchObject({ id: "ses_1" })
        await expect(
          storage.sessions.findValidByTokenHash({
            projectId,
            id: "ses_2",
            audience: "atlas",
            tokenHash: "hash-2",
            now: at("2026-05-14T10:06:00.000Z"),
          })
        ).resolves.toMatchObject({ id: "ses_2" })
        await expect(
          storage.sessions.findValidByTokenHash({
            projectId,
            id: "ses_2",
            audience: "atlas",
            tokenHash: "wrong",
            now: at("2026-05-14T10:06:00.000Z"),
          })
        ).resolves.toBeNull()

        // getActiveByUserId returns the most recently created active session.
        await expect(
          storage.sessions.getActiveByUserId({
            projectId,
            userId: "usr_1",
            audience: "atlas",
            now: at("2026-05-14T10:06:00.000Z"),
          })
        ).resolves.toMatchObject({ id: "ses_2" })

        const touched = await storage.sessions.touch({
          projectId,
          id: second.id,
          lastSeenAt: at("2026-05-15T10:00:00.000Z"),
        })
        expect(touched.lastSeenAt?.toISOString()).toBe("2026-05-15T10:00:00.000Z")
        expect(touched.expiresAt.toISOString()).toBe("2026-05-21T10:05:00.000Z")

        // A session in a different audience coexists and is cookie-scoped.
        const appSession = await storage.sessions.create({
          id: "ses_app",
          projectId,
          userId: "usr_1",
          strategyId: "magic-link",
          audience: "app",
          tokenHash: "hash-app",
          createdAt: at("2026-05-14T10:06:00.000Z"),
          expiresAt: at("2026-05-21T10:06:00.000Z"),
        })
        expect(appSession.revokedAt).toBeUndefined()
        await expect(
          storage.sessions.findValidByTokenHash({
            projectId,
            id: "ses_app",
            audience: "atlas",
            tokenHash: "hash-app",
            now: at("2026-05-14T10:07:00.000Z"),
          })
        ).resolves.toBeNull()

        // Revoking a single session leaves the user's other sessions active.
        await storage.sessions.revoke({
          projectId,
          id: "ses_1",
          revokedAt: at("2026-05-14T10:08:00.000Z"),
        })
        await expect(
          storage.sessions.findValidByTokenHash({
            projectId,
            id: "ses_1",
            audience: "atlas",
            tokenHash: "hash-1",
            now: at("2026-05-14T10:09:00.000Z"),
          })
        ).resolves.toBeNull()
        await expect(
          storage.sessions.findValidByTokenHash({
            projectId,
            id: "ses_2",
            audience: "atlas",
            tokenHash: "hash-2",
            now: at("2026-05-14T10:09:00.000Z"),
          })
        ).resolves.toMatchObject({ id: "ses_2" })

        // "Sign out everywhere": revokeActiveForUser clears every remaining
        // active session for the user, across audiences.
        const revoked = await storage.sessions.revokeActiveForUser({
          projectId,
          userId: "usr_1",
          revokedAt: at("2026-05-14T10:10:00.000Z"),
        })
        expect(revoked.map((entry) => entry.id).sort()).toEqual(["ses_2", "ses_app"])
        await expect(
          storage.sessions.getActiveByUserId({
            projectId,
            userId: "usr_1",
            audience: "atlas",
            now: at("2026-05-14T10:11:00.000Z"),
          })
        ).resolves.toBeNull()
      })
    })

    test("persists best-effort device metadata on a session", async () => {
      await withStorage(async (storage) => {
        await createUser(storage)

        const withDevice = await storage.sessions.create({
          id: "ses_device",
          projectId,
          userId: "usr_1",
          strategyId: "magic-link",
          audience: "atlas",
          tokenHash: "hash-device",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-21T10:00:00.000Z"),
          userAgent: "Mozilla/5.0 (iPhone)",
          ipAddress: "203.0.113.7",
        })
        expect(withDevice.userAgent).toBe("Mozilla/5.0 (iPhone)")
        expect(withDevice.ipAddress).toBe("203.0.113.7")
        await expect(
          storage.sessions.getById({ projectId, id: "ses_device" })
        ).resolves.toMatchObject({
          userAgent: "Mozilla/5.0 (iPhone)",
          ipAddress: "203.0.113.7",
        })

        // Device metadata is optional; omitting it round-trips as undefined.
        const withoutDevice = await storage.sessions.create({
          id: "ses_plain",
          projectId,
          userId: "usr_1",
          strategyId: "magic-link",
          audience: "atlas",
          tokenHash: "hash-plain",
          createdAt: at("2026-05-14T10:01:00.000Z"),
          expiresAt: at("2026-05-21T10:01:00.000Z"),
        })
        expect(withoutDevice.userAgent).toBeUndefined()
        expect(withoutDevice.ipAddress).toBeUndefined()
      })
    })

    test("lists a user's active sessions across audiences, newest activity first", async () => {
      await withStorage(async (storage) => {
        await createUser(storage)

        await storage.sessions.create({
          id: "ses_a",
          projectId,
          userId: "usr_1",
          strategyId: "magic-link",
          audience: "atlas",
          tokenHash: "hash-a",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-21T10:00:00.000Z"),
        })
        await storage.sessions.create({
          id: "ses_b",
          projectId,
          userId: "usr_1",
          strategyId: "magic-link",
          audience: "app",
          tokenHash: "hash-b",
          createdAt: at("2026-05-14T10:05:00.000Z"),
          expiresAt: at("2026-05-21T10:05:00.000Z"),
        })

        // Revoked sessions are excluded.
        await storage.sessions.create({
          id: "ses_revoked",
          projectId,
          userId: "usr_1",
          strategyId: "magic-link",
          audience: "atlas",
          tokenHash: "hash-revoked",
          createdAt: at("2026-05-14T10:01:00.000Z"),
          expiresAt: at("2026-05-21T10:01:00.000Z"),
        })
        await storage.sessions.revoke({
          projectId,
          id: "ses_revoked",
          revokedAt: at("2026-05-14T10:02:00.000Z"),
        })

        // Another user's session must not leak in.
        await createUser(storage, { id: "usr_2", email: "bo@acme.com" })
        await storage.sessions.create({
          id: "ses_other",
          projectId,
          userId: "usr_2",
          strategyId: "magic-link",
          audience: "atlas",
          tokenHash: "hash-other",
          createdAt: at("2026-05-14T10:03:00.000Z"),
          expiresAt: at("2026-05-21T10:03:00.000Z"),
        })

        // ses_a is older than ses_b but has more recent activity, so it sorts first.
        await storage.sessions.touch({
          projectId,
          id: "ses_a",
          lastSeenAt: at("2026-05-15T10:00:00.000Z"),
        })

        const active = await storage.sessions.listActiveByUserId({
          projectId,
          userId: "usr_1",
          now: at("2026-05-15T11:00:00.000Z"),
        })
        expect(active.map((session) => session.id)).toEqual(["ses_a", "ses_b"])
      })
    })

    test("keeps one active invitation per normalized email", async () => {
      await withStorage(async (storage) => {
        const first = await storage.invitations.createOrUpdateActive({
          id: "inv_1",
          projectId,
          email: " Ava@Acme.COM ",
          groupIds: ["commercial"],
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-21T10:00:00.000Z"),
        })
        const updated = await storage.invitations.createOrUpdateActive({
          id: "inv_2",
          projectId,
          email: "ava@acme.com",
          groupIds: ["finance"],
          updatedAt: at("2026-05-14T10:01:00.000Z"),
          expiresAt: at("2026-05-22T10:00:00.000Z"),
        })

        expect(updated.id).toBe(first.id)
        expect(updated.groupIds).toEqual(["finance"])
        await expect(
          storage.invitations.getActiveByEmail({
            projectId,
            email: "ava@acme.com",
            now: at("2026-05-14T10:02:00.000Z"),
          })
        ).resolves.toMatchObject({ id: "inv_1" })

        await storage.invitations.revoke({
          projectId,
          id: "inv_1",
          revokedAt: at("2026-05-14T10:03:00.000Z"),
        })
        await expect(
          storage.invitations.getActiveByEmail({
            projectId,
            email: "ava@acme.com",
            now: at("2026-05-14T10:04:00.000Z"),
          })
        ).resolves.toBeNull()
      })
    })

    test("upserts group memberships idempotently and preserves source", async () => {
      await withStorage(async (storage) => {
        await createUser(storage)

        await storage.groupMemberships.upsert({
          projectId,
          userId: "usr_1",
          groupId: "commercial",
          source: "invitation",
          createdAt: at("2026-05-14T10:00:00.000Z"),
        })
        const repeated = await storage.groupMemberships.upsert({
          projectId,
          userId: "usr_1",
          groupId: "commercial",
          source: "manual",
          createdAt: at("2026-05-14T10:01:00.000Z"),
        })

        expect(repeated.source).toBe("invitation")
        await expect(
          storage.groupMemberships.listForUser({ projectId, userId: "usr_1" })
        ).resolves.toHaveLength(1)
      })
    })

    test("rejects group memberships for missing users", async () => {
      await withStorage(async (storage) => {
        await expectAuthError(
          storage.groupMemberships.upsert({
            projectId,
            userId: "usr_missing",
            groupId: "commercial",
            source: "manual",
            createdAt: at("2026-05-14T10:00:00.000Z"),
          }),
          "missing_user"
        )
      })
    })

    test("manages service accounts and their group memberships", async () => {
      await withStorage(async (storage) => {
        const serviceAccount = await storage.serviceAccounts.create({
          id: "svc_ingest",
          projectId,
          name: "Ingest worker",
          description: "Reads source data into Sixb.",
          createdAt: at("2026-05-14T10:00:00.000Z"),
        })
        expect(serviceAccount).toMatchObject({
          id: "svc_ingest",
          name: "Ingest worker",
          status: "active",
        })

        const membership = await storage.serviceAccountGroupMemberships.upsert({
          projectId,
          serviceAccountId: "svc_ingest",
          groupId: "commercial",
          source: "manual",
          createdAt: at("2026-05-14T10:01:00.000Z"),
        })
        expect(membership.groupId).toBe("commercial")
        const repeated = await storage.serviceAccountGroupMemberships.upsert({
          projectId,
          serviceAccountId: "svc_ingest",
          groupId: "commercial",
          source: "invitation",
          createdAt: at("2026-05-14T10:02:00.000Z"),
        })
        expect(repeated.source).toBe("manual")

        await expect(
          storage.serviceAccountGroupMemberships.listForServiceAccount({
            projectId,
            serviceAccountId: "svc_ingest",
          })
        ).resolves.toHaveLength(1)
        await expect(
          storage.serviceAccountGroupMemberships.listForGroup({
            projectId,
            groupId: "commercial",
          })
        ).resolves.toMatchObject([{ serviceAccountId: "svc_ingest" }])

        const updated = await storage.serviceAccounts.update({
          projectId,
          id: "svc_ingest",
          name: "Ingest worker v2",
          status: "suspended",
          updatedAt: at("2026-05-14T10:03:00.000Z"),
        })
        expect(updated).toMatchObject({ name: "Ingest worker v2", status: "suspended" })
        await expect(
          storage.serviceAccounts.list({ projectId, statuses: ["suspended"] })
        ).resolves.toMatchObject({
          serviceAccounts: [{ id: "svc_ingest" }],
          total: 1,
        })
      })
    })

    test("rejects service account memberships for missing service accounts", async () => {
      await withStorage(async (storage) => {
        await expectAuthError(
          storage.serviceAccountGroupMemberships.upsert({
            projectId,
            serviceAccountId: "svc_missing",
            groupId: "commercial",
            source: "manual",
            createdAt: at("2026-05-14T10:00:00.000Z"),
          }),
          "missing_service_account"
        )
      })
    })

    test("creates, resolves, touches, lists, and revokes access tokens", async () => {
      await withStorage(async (storage) => {
        await createUser(storage)
        await storage.serviceAccounts.create({
          id: "svc_ingest",
          projectId,
          name: "Ingest worker",
          createdAt: at("2026-05-14T10:00:00.000Z"),
        })

        const personal = await storage.accessTokens.create({
          id: "tok_personal",
          projectId,
          name: "Local CLI",
          kind: "personal",
          subjectType: "user",
          subjectId: "usr_1",
          tokenHash: "hash-personal",
          groupIds: ["commercial", "commercial", "finance"],
          createdAt: at("2026-05-14T10:01:00.000Z"),
          expiresAt: at("2026-05-21T10:01:00.000Z"),
        })
        expect(personal.groupIds).toEqual(["commercial", "finance"])
        await expect(
          storage.accessTokens.findValidByTokenHash({
            projectId,
            id: "tok_personal",
            kind: "personal",
            tokenHash: "hash-personal",
            now: at("2026-05-14T10:02:00.000Z"),
          })
        ).resolves.toMatchObject({ id: "tok_personal" })
        await expect(
          storage.accessTokens.findValidByTokenHash({
            projectId,
            id: "tok_personal",
            kind: "personal",
            tokenHash: "wrong",
            now: at("2026-05-14T10:02:00.000Z"),
          })
        ).resolves.toBeNull()

        const touched = await storage.accessTokens.touch({
          projectId,
          id: "tok_personal",
          lastUsedAt: at("2026-05-14T10:03:00.000Z"),
          userAgent: "sixb-cli/0.1",
          ipAddress: "203.0.113.10",
        })
        expect(touched.lastUsedAt?.toISOString()).toBe("2026-05-14T10:03:00.000Z")
        expect(touched.lastUsedUserAgent).toBe("sixb-cli/0.1")

        await storage.accessTokens.create({
          id: "tok_service",
          projectId,
          name: "Sandbox agent",
          kind: "serviceAccount",
          subjectType: "serviceAccount",
          subjectId: "svc_ingest",
          tokenHash: "hash-service",
          createdAt: at("2026-05-14T10:04:00.000Z"),
          expiresAt: at("2026-05-21T10:04:00.000Z"),
        })
        await expect(
          storage.accessTokens.list({
            projectId,
            subjectType: "serviceAccount",
            subjectId: "svc_ingest",
          })
        ).resolves.toMatchObject({
          accessTokens: [{ id: "tok_service" }],
          total: 1,
        })

        await storage.accessTokens.revoke({
          projectId,
          id: "tok_personal",
          revokedAt: at("2026-05-14T10:05:00.000Z"),
        })
        await expect(
          storage.accessTokens.findValidByTokenHash({
            projectId,
            id: "tok_personal",
            kind: "personal",
            tokenHash: "hash-personal",
            now: at("2026-05-14T10:06:00.000Z"),
          })
        ).resolves.toBeNull()
      })
    })

    test("round-trips the creator principal for service accounts and access tokens", async () => {
      await withStorage(async (storage) => {
        await createUser(storage, { id: "usr_creator", email: "creator@acme.com" })
        await storage.serviceAccounts.create({
          id: "svc_creator",
          projectId,
          name: "Creator service account",
          createdAt: at("2026-05-14T10:00:00.000Z"),
        })
        await storage.sessions.create({
          id: "ses_creator",
          projectId,
          userId: "usr_creator",
          strategyId: "magic-link",
          audience: "atlas",
          tokenHash: "hash-creator",
          createdAt: at("2026-05-14T10:00:30.000Z"),
          expiresAt: at("2026-05-21T10:00:30.000Z"),
        })

        const principals = [
          { type: "user", id: "usr_creator" },
          { type: "serviceAccount", id: "svc_creator" },
          { type: "system", id: "scheduler" },
        ] as const

        for (const [index, principal] of principals.entries()) {
          const accountId = `svc_by_${principal.type}`
          const createdAccount = await storage.serviceAccounts.create({
            id: accountId,
            projectId,
            name: `Service account by ${principal.type}`,
            createdByPrincipal: principal,
            createdBySessionId: "ses_creator",
            createdAt: at(`2026-05-14T10:1${index}:00.000Z`),
          })
          expect(createdAccount.createdByPrincipal).toEqual(principal)
          expect(createdAccount.createdBySessionId).toBe("ses_creator")
          await expect(
            storage.serviceAccounts.getById({ projectId, id: accountId })
          ).resolves.toMatchObject({
            createdByPrincipal: principal,
            createdBySessionId: "ses_creator",
          })

          const tokenId = `tok_by_${principal.type}`
          const createdToken = await storage.accessTokens.create({
            id: tokenId,
            projectId,
            name: `Token by ${principal.type}`,
            kind: "personal",
            subjectType: "user",
            subjectId: "usr_creator",
            tokenHash: `hash-${tokenId}`,
            createdByPrincipal: principal,
            createdBySessionId: "ses_creator",
            createdAt: at(`2026-05-14T10:2${index}:00.000Z`),
            expiresAt: at(`2026-05-21T10:2${index}:00.000Z`),
          })
          expect(createdToken.createdByPrincipal).toEqual(principal)
          expect(createdToken.createdBySessionId).toBe("ses_creator")
          await expect(
            storage.accessTokens.getById({ projectId, id: tokenId })
          ).resolves.toMatchObject({
            createdByPrincipal: principal,
            createdBySessionId: "ses_creator",
          })
        }

        // Omitting the creator round-trips as undefined on every backend.
        const anonymous = await storage.serviceAccounts.create({
          id: "svc_anonymous",
          projectId,
          name: "Anonymous service account",
          createdAt: at("2026-05-14T10:30:00.000Z"),
        })
        expect(anonymous.createdByPrincipal).toBeUndefined()
        expect(anonymous.createdBySessionId).toBeUndefined()
        await expect(
          storage.serviceAccounts.getById({ projectId, id: "svc_anonymous" })
        ).resolves.toMatchObject({ id: "svc_anonymous" })
      })
    })

    test("touch preserves prior access-token metadata when omitted", async () => {
      await withStorage(async (storage) => {
        await createUser(storage)
        await storage.accessTokens.create({
          id: "tok_touch",
          projectId,
          name: "Touch token",
          kind: "personal",
          subjectType: "user",
          subjectId: "usr_1",
          tokenHash: "hash-touch",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-21T10:00:00.000Z"),
        })

        const first = await storage.accessTokens.touch({
          projectId,
          id: "tok_touch",
          lastUsedAt: at("2026-05-14T10:01:00.000Z"),
          userAgent: "sixb-cli/0.1",
          ipAddress: "203.0.113.10",
        })
        expect(first.lastUsedUserAgent).toBe("sixb-cli/0.1")
        expect(first.lastUsedIpAddress).toBe("203.0.113.10")

        // A later touch without metadata advances lastUsedAt but keeps the
        // previously captured user agent and IP address.
        const second = await storage.accessTokens.touch({
          projectId,
          id: "tok_touch",
          lastUsedAt: at("2026-05-14T10:05:00.000Z"),
        })
        expect(second.lastUsedAt?.toISOString()).toBe("2026-05-14T10:05:00.000Z")
        expect(second.lastUsedUserAgent).toBe("sixb-cli/0.1")
        expect(second.lastUsedIpAddress).toBe("203.0.113.10")
        await expect(
          storage.accessTokens.getById({ projectId, id: "tok_touch" })
        ).resolves.toMatchObject({
          lastUsedUserAgent: "sixb-cli/0.1",
          lastUsedIpAddress: "203.0.113.10",
        })
      })
    })

    test("lists access tokens with revoked, order, and pagination parity", async () => {
      await withStorage(async (storage) => {
        await createUser(storage)

        const ids = ["tok_a", "tok_b", "tok_c", "tok_d"]
        for (const [index, id] of ids.entries()) {
          await storage.accessTokens.create({
            id,
            projectId,
            name: `Token ${id}`,
            kind: "personal",
            subjectType: "user",
            subjectId: "usr_1",
            tokenHash: `hash-${id}`,
            createdAt: at(`2026-05-14T10:0${index}:00.000Z`),
            expiresAt: at(`2026-05-21T10:0${index}:00.000Z`),
          })
        }
        await storage.accessTokens.revoke({
          projectId,
          id: "tok_b",
          revokedAt: at("2026-05-14T11:00:00.000Z"),
        })

        // includeRevoked defaults to false: the revoked token is hidden.
        const active = await storage.accessTokens.list({ projectId })
        expect(active.accessTokens.map((token) => token.id)).toEqual(["tok_a", "tok_c", "tok_d"])
        expect(active.total).toBe(3)
        expect(active.hasMore).toBe(false)

        // includeRevoked: true surfaces it again, default order is ascending.
        const all = await storage.accessTokens.list({ projectId, includeRevoked: true })
        expect(all.accessTokens.map((token) => token.id)).toEqual([
          "tok_a",
          "tok_b",
          "tok_c",
          "tok_d",
        ])
        expect(all.total).toBe(4)

        // order: "desc" reverses by createdAt.
        const descending = await storage.accessTokens.list({
          projectId,
          includeRevoked: true,
          order: "desc",
        })
        expect(descending.accessTokens.map((token) => token.id)).toEqual([
          "tok_d",
          "tok_c",
          "tok_b",
          "tok_a",
        ])

        // First page reports hasMore at the page boundary.
        const firstPage = await storage.accessTokens.list({
          projectId,
          includeRevoked: true,
          limit: 2,
        })
        expect(firstPage.accessTokens.map((token) => token.id)).toEqual(["tok_a", "tok_b"])
        expect(firstPage.total).toBe(4)
        expect(firstPage.hasMore).toBe(true)

        // Second page exhausts the result set.
        const secondPage = await storage.accessTokens.list({
          projectId,
          includeRevoked: true,
          limit: 2,
          offset: 2,
        })
        expect(secondPage.accessTokens.map((token) => token.id)).toEqual(["tok_c", "tok_d"])
        expect(secondPage.hasMore).toBe(false)

        // A page that exactly consumes the remainder reports no more.
        const exactBoundary = await storage.accessTokens.list({
          projectId,
          includeRevoked: true,
          limit: 4,
        })
        expect(exactBoundary.accessTokens.map((token) => token.id)).toEqual(ids)
        expect(exactBoundary.hasMore).toBe(false)
      })
    })

    test("lists service accounts with pagination parity", async () => {
      await withStorage(async (storage) => {
        const ids = ["svc_a", "svc_b", "svc_c"]
        for (const [index, id] of ids.entries()) {
          await storage.serviceAccounts.create({
            id,
            projectId,
            name: `Service account ${id}`,
            createdAt: at(`2026-05-14T10:0${index}:00.000Z`),
          })
        }

        // Default order is ascending by createdAt across every backend.
        const all = await storage.serviceAccounts.list({ projectId })
        expect(all.serviceAccounts.map((account) => account.id)).toEqual(ids)
        expect(all.total).toBe(3)
        expect(all.hasMore).toBe(false)

        const firstPage = await storage.serviceAccounts.list({ projectId, limit: 2 })
        expect(firstPage.serviceAccounts.map((account) => account.id)).toEqual(["svc_a", "svc_b"])
        expect(firstPage.total).toBe(3)
        expect(firstPage.hasMore).toBe(true)

        const secondPage = await storage.serviceAccounts.list({
          projectId,
          limit: 2,
          offset: 2,
        })
        expect(secondPage.serviceAccounts.map((account) => account.id)).toEqual(["svc_c"])
        expect(secondPage.hasMore).toBe(false)
      })
    })

    test("rejects invalid access token subjects", async () => {
      await withStorage(async (storage) => {
        await createUser(storage)

        await expectAuthError(
          storage.accessTokens.create({
            id: "tok_bad_kind",
            projectId,
            name: "Bad kind",
            kind: "serviceAccount",
            subjectType: "user",
            subjectId: "usr_1",
            tokenHash: "hash",
            createdAt: at("2026-05-14T10:00:00.000Z"),
            expiresAt: at("2026-05-21T10:00:00.000Z"),
          }),
          "invalid_input"
        )
        await expectAuthError(
          storage.accessTokens.create({
            id: "tok_missing_subject",
            projectId,
            name: "Missing subject",
            kind: "serviceAccount",
            subjectType: "serviceAccount",
            subjectId: "svc_missing",
            tokenHash: "hash",
            createdAt: at("2026-05-14T10:00:00.000Z"),
            expiresAt: at("2026-05-21T10:00:00.000Z"),
          }),
          "missing_service_account"
        )
      })
    })

    test("creates one active magic link per email and consumes it once", async () => {
      await withStorage(async (storage) => {
        await storage.magicLinks.create({
          id: "ml_1",
          projectId,
          strategyId: "magic-link",
          audience: "atlas",
          email: "ava@acme.com",
          tokenHash: "hash-1",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-14T10:15:00.000Z"),
        })
        await storage.magicLinks.create({
          id: "ml_2",
          projectId,
          strategyId: "magic-link",
          audience: "atlas",
          email: " ava@acme.com ",
          tokenHash: "hash-2",
          returnTo: "/dashboard",
          createdAt: at("2026-05-14T10:01:00.000Z"),
          expiresAt: at("2026-05-14T10:16:00.000Z"),
        })

        await expect(storage.magicLinks.getById({ projectId, id: "ml_1" })).resolves.toMatchObject({
          revokedAt: at("2026-05-14T10:01:00.000Z"),
        })
        await expectAuthError(
          storage.magicLinks.consume({
            projectId,
            id: "ml_2",
            tokenHash: "wrong",
            consumedAt: at("2026-05-14T10:02:00.000Z"),
          }),
          "invalid_magic_link"
        )

        await expect(
          storage.magicLinks.consume({
            projectId,
            id: "ml_2",
            tokenHash: "hash-2",
            consumedAt: at("2026-05-14T10:02:00.000Z"),
          })
        ).resolves.toMatchObject({
          audience: "atlas",
          returnTo: "/dashboard",
          consumedAt: at("2026-05-14T10:02:00.000Z"),
        })
        await expectAuthError(
          storage.magicLinks.consume({
            projectId,
            id: "ml_2",
            tokenHash: "hash-2",
            consumedAt: at("2026-05-14T10:03:00.000Z"),
          }),
          "invalid_magic_link"
        )
      })
    })

    test("stores OIDC attempts with one-time state consumption", async () => {
      await withStorage(async (storage) => {
        await storage.oidcAuthorizationAttempts.create({
          id: "oidc_1",
          projectId,
          strategyId: "okta",
          audience: "atlas",
          stateHash: "state-hash",
          nonceHash: "nonce-hash",
          codeVerifier: "verifier",
          returnTo: "/objects",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-14T10:10:00.000Z"),
        })

        await expectAuthError(
          storage.oidcAuthorizationAttempts.consume({
            projectId,
            id: "oidc_1",
            stateHash: "wrong",
            consumedAt: at("2026-05-14T10:01:00.000Z"),
          }),
          "invalid_oidc_attempt"
        )
        await expect(
          storage.oidcAuthorizationAttempts.consume({
            projectId,
            id: "oidc_1",
            stateHash: "state-hash",
            consumedAt: at("2026-05-14T10:01:00.000Z"),
          })
        ).resolves.toMatchObject({
          audience: "atlas",
          codeVerifier: "verifier",
          consumedAt: at("2026-05-14T10:01:00.000Z"),
        })
        await expectAuthError(
          storage.oidcAuthorizationAttempts.consume({
            projectId,
            id: "oidc_1",
            stateHash: "state-hash",
            consumedAt: at("2026-05-14T10:02:00.000Z"),
          }),
          "invalid_oidc_attempt"
        )
      })
    })

    test("completes magic-link sign-in for an existing user", async () => {
      await withStorage(async (storage) => {
        await createUser(storage)
        await storage.sessions.create({
          id: "ses_old",
          projectId,
          userId: "usr_1",
          strategyId: "magic-link",
          audience: "atlas",
          tokenHash: "old-hash",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-21T10:00:00.000Z"),
        })
        await storage.magicLinks.create({
          id: "ml_1",
          projectId,
          strategyId: "magic-link",
          audience: "atlas",
          email: "ava@acme.com",
          tokenHash: "link-hash",
          createdAt: at("2026-05-14T10:01:00.000Z"),
          expiresAt: at("2026-05-14T10:16:00.000Z"),
        })

        const result = await storage.completeMagicLinkSignIn({
          projectId,
          magicLinkId: "ml_1",
          tokenHash: "link-hash",
          completedAt: at("2026-05-14T10:02:00.000Z"),
          newUserId: "usr_unused",
          session: sessionInput("ses_new", "session-hash"),
        })

        expect(result.user.id).toBe("usr_1")
        expect(result.session).toMatchObject({
          id: "ses_new",
          strategyId: "magic-link",
          tokenHash: "session-hash",
        })
        // Signing in again keeps the user's existing session active; concurrent
        // sessions are allowed.
        const oldSession = await storage.sessions.getById({ projectId, id: "ses_old" })
        expect(oldSession?.revokedAt).toBeUndefined()
        await expectAuthError(
          storage.completeMagicLinkSignIn({
            projectId,
            magicLinkId: "ml_1",
            tokenHash: "link-hash",
            completedAt: at("2026-05-14T10:03:00.000Z"),
            newUserId: "usr_unused_2",
            session: sessionInput("ses_replay"),
          }),
          "invalid_magic_link"
        )
      })
    })

    test("creates invited users through magic-link completion and applies groups once", async () => {
      await withStorage(async (storage) => {
        await storage.invitations.createOrUpdateActive({
          id: "inv_1",
          projectId,
          email: "ava@acme.com",
          groupIds: ["commercial", "finance"],
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-21T10:00:00.000Z"),
        })
        await storage.magicLinks.create({
          id: "ml_1",
          projectId,
          strategyId: "magic-link",
          audience: "atlas",
          email: "ava@acme.com",
          tokenHash: "link-hash",
          createdAt: at("2026-05-14T10:02:00.000Z"),
          expiresAt: at("2026-05-14T10:17:00.000Z"),
        })

        const result = await storage.completeMagicLinkSignIn({
          projectId,
          magicLinkId: "ml_1",
          tokenHash: "link-hash",
          completedAt: at("2026-05-14T10:03:00.000Z"),
          newUserId: "usr_new",
          manualGroupIds: ["security-admins"],
          session: sessionInput("ses_new"),
        })

        expect(result.invitation).toMatchObject({
          id: "inv_1",
          status: "accepted",
        })
        const memberships = await storage.groupMemberships.listForUser({
          projectId,
          userId: "usr_new",
        })
        expect(memberships.map((membership) => [membership.groupId, membership.source])).toEqual([
          ["commercial", "invitation"],
          ["finance", "invitation"],
          ["security-admins", "manual"],
        ])
      })
    })

    test("preserves existing membership source when accepting an invitation", async () => {
      await withStorage(async (storage) => {
        await createUser(storage, { id: "usr_existing", email: "ava@acme.com" })
        await storage.invitations.createOrUpdateActive({
          id: "inv_1",
          projectId,
          email: "ava@acme.com",
          groupIds: ["commercial", "finance"],
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-21T10:00:00.000Z"),
        })
        await storage.groupMemberships.upsert({
          projectId,
          userId: "usr_existing",
          groupId: "commercial",
          source: "manual",
          createdAt: at("2026-05-14T10:01:00.000Z"),
        })
        await storage.magicLinks.create({
          id: "ml_1",
          projectId,
          strategyId: "magic-link",
          audience: "atlas",
          email: "ava@acme.com",
          tokenHash: "link-hash",
          createdAt: at("2026-05-14T10:02:00.000Z"),
          expiresAt: at("2026-05-14T10:17:00.000Z"),
        })

        await storage.completeMagicLinkSignIn({
          projectId,
          magicLinkId: "ml_1",
          tokenHash: "link-hash",
          completedAt: at("2026-05-14T10:03:00.000Z"),
          newUserId: "usr_unused",
          session: sessionInput("ses_existing"),
        })

        const memberships = await storage.groupMemberships.listForUser({
          projectId,
          userId: "usr_existing",
        })
        expect(memberships.map((membership) => [membership.groupId, membership.source])).toEqual([
          ["commercial", "manual"],
          ["finance", "invitation"],
        ])
      })
    })

    test("does not create missing users when invitation eligibility disappeared", async () => {
      await withStorage(async (storage) => {
        await storage.invitations.createOrUpdateActive({
          id: "inv_1",
          projectId,
          email: "ava@acme.com",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-21T10:00:00.000Z"),
        })
        await storage.magicLinks.create({
          id: "ml_1",
          projectId,
          strategyId: "magic-link",
          audience: "atlas",
          email: "ava@acme.com",
          tokenHash: "link-hash",
          createdAt: at("2026-05-14T10:01:00.000Z"),
          expiresAt: at("2026-05-14T10:16:00.000Z"),
        })
        await storage.invitations.revoke({
          projectId,
          id: "inv_1",
          revokedAt: at("2026-05-14T10:02:00.000Z"),
        })

        await expectAuthError(
          storage.completeMagicLinkSignIn({
            projectId,
            magicLinkId: "ml_1",
            tokenHash: "link-hash",
            completedAt: at("2026-05-14T10:03:00.000Z"),
            newUserId: "usr_new",
            session: sessionInput("ses_new"),
          }),
          "user_creation_not_allowed"
        )
        await expect(
          storage.users.getByEmail({ projectId, email: "ava@acme.com" })
        ).resolves.toBeNull()
        await expect(storage.magicLinks.getById({ projectId, id: "ml_1" })).resolves.toMatchObject({
          consumedAt: at("2026-05-14T10:03:00.000Z"),
        })
      })
    })

    test("allows explicit bootstrap creation through magic-link completion", async () => {
      await withStorage(async (storage) => {
        await storage.magicLinks.create({
          id: "ml_1",
          projectId,
          strategyId: "magic-link",
          audience: "atlas",
          email: "founder@acme.com",
          tokenHash: "link-hash",
          createdAt: at("2026-05-14T10:01:00.000Z"),
          expiresAt: at("2026-05-14T10:16:00.000Z"),
        })

        const result = await storage.completeMagicLinkSignIn({
          projectId,
          magicLinkId: "ml_1",
          tokenHash: "link-hash",
          completedAt: at("2026-05-14T10:03:00.000Z"),
          newUserId: "usr_founder",
          allowUserCreationWithoutInvitation: true,
          manualGroupIds: ["security-admins"],
          session: sessionInput("ses_founder"),
        })

        expect(result.user).toMatchObject({
          id: "usr_founder",
          email: "founder@acme.com",
        })
        await expect(
          storage.groupMemberships.listForUser({ projectId, userId: "usr_founder" })
        ).resolves.toMatchObject([{ groupId: "security-admins", source: "manual" }])
      })
    })

    test("closes bootstrap user creation when an active user already exists", async () => {
      await withStorage(async (storage) => {
        await createUser(storage, {
          id: "usr_existing",
          email: "existing@acme.com",
        })
        await storage.magicLinks.create({
          id: "ml_1",
          projectId,
          strategyId: "magic-link",
          audience: "atlas",
          email: "founder@acme.com",
          tokenHash: "link-hash",
          createdAt: at("2026-05-14T10:01:00.000Z"),
          expiresAt: at("2026-05-14T10:16:00.000Z"),
        })

        await expectAuthError(
          storage.completeMagicLinkSignIn({
            projectId,
            magicLinkId: "ml_1",
            tokenHash: "link-hash",
            completedAt: at("2026-05-14T10:03:00.000Z"),
            newUserId: "usr_founder",
            allowUserCreationWithoutInvitation: true,
            requireNoActiveUsersForUserCreation: true,
            session: sessionInput("ses_founder"),
          }),
          "user_creation_not_allowed"
        )
        await expect(
          storage.users.getByEmail({ projectId, email: "founder@acme.com" })
        ).resolves.toBeNull()
        await expect(storage.magicLinks.getById({ projectId, id: "ml_1" })).resolves.toMatchObject({
          consumedAt: at("2026-05-14T10:03:00.000Z"),
        })
      })
    })

    test("does not apply the bootstrap closure guard to invited user creation", async () => {
      await withStorage(async (storage) => {
        await createUser(storage, {
          id: "usr_existing",
          email: "existing@acme.com",
        })
        await storage.invitations.createOrUpdateActive({
          id: "inv_1",
          projectId,
          email: "invited@acme.com",
          groupIds: ["commercial"],
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-21T10:00:00.000Z"),
        })
        await storage.magicLinks.create({
          id: "ml_1",
          projectId,
          strategyId: "magic-link",
          audience: "atlas",
          email: "invited@acme.com",
          tokenHash: "link-hash",
          createdAt: at("2026-05-14T10:01:00.000Z"),
          expiresAt: at("2026-05-14T10:16:00.000Z"),
        })

        const result = await storage.completeMagicLinkSignIn({
          projectId,
          magicLinkId: "ml_1",
          tokenHash: "link-hash",
          completedAt: at("2026-05-14T10:03:00.000Z"),
          newUserId: "usr_invited",
          requireNoActiveUsersForUserCreation: true,
          session: sessionInput("ses_invited"),
        })

        expect(result.user).toMatchObject({
          id: "usr_invited",
          email: "invited@acme.com",
        })
        expect(result.invitation).toMatchObject({
          id: "inv_1",
          status: "accepted",
        })
      })
    })

    test("consumes valid magic links when an existing user is suspended", async () => {
      await withStorage(async (storage) => {
        await createUser(storage, { status: "suspended" })
        await storage.magicLinks.create({
          id: "ml_1",
          projectId,
          strategyId: "magic-link",
          audience: "atlas",
          email: "ava@acme.com",
          tokenHash: "link-hash",
          createdAt: at("2026-05-14T10:01:00.000Z"),
          expiresAt: at("2026-05-14T10:16:00.000Z"),
        })

        await expectAuthError(
          storage.completeMagicLinkSignIn({
            projectId,
            magicLinkId: "ml_1",
            tokenHash: "link-hash",
            completedAt: at("2026-05-14T10:02:00.000Z"),
            newUserId: "usr_unused",
            session: sessionInput("ses_new"),
          }),
          "suspended_user"
        )
        await expect(storage.magicLinks.getById({ projectId, id: "ml_1" })).resolves.toMatchObject({
          consumedAt: at("2026-05-14T10:02:00.000Z"),
        })
      })
    })

    test("completes OIDC sign-in through an existing identity", async () => {
      await withStorage(async (storage) => {
        await createUser(storage, { id: "usr_oidc", email: "ava@acme.com" })
        await storage.identities.upsert({
          projectId,
          strategyId: "okta",
          subject: "00u1",
          userId: "usr_oidc",
          claims: { email: "ava@acme.com" },
          createdAt: at("2026-05-14T10:00:00.000Z"),
        })
        await storage.oidcAuthorizationAttempts.create({
          id: "oidc_1",
          projectId,
          strategyId: "okta",
          audience: "atlas",
          stateHash: "state-hash",
          nonceHash: "nonce-hash",
          codeVerifier: "verifier",
          createdAt: at("2026-05-14T10:01:00.000Z"),
          expiresAt: at("2026-05-14T10:11:00.000Z"),
        })

        const result = await storage.completeOidcSignIn({
          projectId,
          oidcAuthorizationAttemptId: "oidc_1",
          stateHash: "state-hash",
          completedAt: at("2026-05-14T10:02:00.000Z"),
          subject: "00u1",
          email: "renamed@acme.com",
          emailVerified: true,
          claims: { email: "renamed@acme.com" },
          newUserId: "usr_unused",
          session: sessionInput("ses_oidc"),
        })

        expect(result.identity).toMatchObject({
          strategyId: "okta",
          subject: "00u1",
          userId: "usr_oidc",
          claims: { email: "renamed@acme.com" },
        })
        await expect(storage.users.getById({ projectId, id: "usr_oidc" })).resolves.toMatchObject({
          email: "ava@acme.com",
        })
      })
    })

    test("auto-links OIDC by verified email only when explicitly allowed", async () => {
      await withStorage(async (storage) => {
        await createUser(storage, { id: "usr_existing", email: "ava@acme.com" })
        await storage.oidcAuthorizationAttempts.create({
          id: "oidc_blocked",
          projectId,
          strategyId: "okta",
          audience: "atlas",
          stateHash: "blocked-state",
          nonceHash: "nonce-hash",
          codeVerifier: "verifier",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-14T10:10:00.000Z"),
        })

        await expectAuthError(
          storage.completeOidcSignIn({
            projectId,
            oidcAuthorizationAttemptId: "oidc_blocked",
            stateHash: "blocked-state",
            completedAt: at("2026-05-14T10:01:00.000Z"),
            subject: "00u1",
            email: "ava@acme.com",
            emailVerified: false,
            autoLinkByVerifiedEmail: true,
            newUserId: "usr_unused",
            session: sessionInput("ses_blocked"),
          }),
          "email_link_not_allowed"
        )

        await storage.oidcAuthorizationAttempts.create({
          id: "oidc_allowed",
          projectId,
          strategyId: "okta",
          audience: "atlas",
          stateHash: "allowed-state",
          nonceHash: "nonce-hash",
          codeVerifier: "verifier",
          createdAt: at("2026-05-14T10:02:00.000Z"),
          expiresAt: at("2026-05-14T10:12:00.000Z"),
        })
        const result = await storage.completeOidcSignIn({
          projectId,
          oidcAuthorizationAttemptId: "oidc_allowed",
          stateHash: "allowed-state",
          completedAt: at("2026-05-14T10:03:00.000Z"),
          subject: "00u1",
          email: "ava@acme.com",
          emailVerified: true,
          autoLinkByVerifiedEmail: true,
          newUserId: "usr_unused",
          session: sessionInput("ses_allowed"),
        })

        expect(result.user.id).toBe("usr_existing")
        expect(result.identity).toMatchObject({
          userId: "usr_existing",
        })
      })
    })

    test("creates new OIDC users through active invitations and applies groups", async () => {
      await withStorage(async (storage) => {
        await storage.invitations.createOrUpdateActive({
          id: "inv_oidc",
          projectId,
          email: "ava@acme.com",
          groupIds: ["commercial"],
          createdAt: at("2026-05-14T09:59:00.000Z"),
          expiresAt: at("2026-05-21T10:00:00.000Z"),
        })
        await storage.oidcAuthorizationAttempts.create({
          id: "oidc_1",
          projectId,
          strategyId: "okta",
          audience: "atlas",
          stateHash: "state-hash",
          nonceHash: "nonce-hash",
          codeVerifier: "verifier",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-14T10:10:00.000Z"),
        })

        const result = await storage.completeOidcSignIn({
          projectId,
          oidcAuthorizationAttemptId: "oidc_1",
          stateHash: "state-hash",
          completedAt: at("2026-05-14T10:01:00.000Z"),
          subject: "00u1",
          email: "ava@acme.com",
          displayName: "Ava Chen",
          emailVerified: true,
          newUserId: "usr_oidc",
          session: sessionInput("ses_oidc"),
        })

        expect(result.user).toMatchObject({
          id: "usr_oidc",
          email: "ava@acme.com",
          displayName: "Ava Chen",
        })
        expect(result.invitation).toMatchObject({
          id: "inv_oidc",
          status: "accepted",
        })
        expect(result.identity).toMatchObject({
          strategyId: "okta",
          subject: "00u1",
          userId: "usr_oidc",
        })
        await expect(
          storage.groupMemberships.listForUser({ projectId, userId: "usr_oidc" })
        ).resolves.toMatchObject([{ groupId: "commercial", source: "invitation" }])
      })
    })

    test("does not create new OIDC users without invitation or bootstrap eligibility", async () => {
      await withStorage(async (storage) => {
        await storage.oidcAuthorizationAttempts.create({
          id: "oidc_1",
          projectId,
          strategyId: "okta",
          audience: "atlas",
          stateHash: "state-hash",
          nonceHash: "nonce-hash",
          codeVerifier: "verifier",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-14T10:10:00.000Z"),
        })

        await expectAuthError(
          storage.completeOidcSignIn({
            projectId,
            oidcAuthorizationAttemptId: "oidc_1",
            stateHash: "state-hash",
            completedAt: at("2026-05-14T10:01:00.000Z"),
            subject: "00u1",
            email: "ava@acme.com",
            emailVerified: true,
            newUserId: "usr_oidc",
            session: sessionInput("ses_oidc"),
          }),
          "user_creation_not_allowed"
        )
        await expect(
          storage.users.getByEmail({ projectId, email: "ava@acme.com" })
        ).resolves.toBeNull()
      })
    })

    test("allows first OIDC bootstrap user creation with manual groups", async () => {
      await withStorage(async (storage) => {
        await storage.oidcAuthorizationAttempts.create({
          id: "oidc_bootstrap",
          projectId,
          strategyId: "okta",
          audience: "atlas",
          stateHash: "bootstrap-state",
          nonceHash: "nonce-hash",
          codeVerifier: "verifier",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-14T10:10:00.000Z"),
        })

        const result = await storage.completeOidcSignIn({
          projectId,
          oidcAuthorizationAttemptId: "oidc_bootstrap",
          stateHash: "bootstrap-state",
          completedAt: at("2026-05-14T10:01:00.000Z"),
          subject: "00u1",
          email: "founder@acme.com",
          emailVerified: true,
          allowUserCreationWithoutInvitation: true,
          requireNoActiveUsersForUserCreation: true,
          manualGroupIds: ["security-admins"],
          newUserId: "usr_founder",
          session: sessionInput("ses_oidc_bootstrap"),
        })

        expect(result.user).toMatchObject({
          id: "usr_founder",
          email: "founder@acme.com",
        })
        await expect(
          storage.groupMemberships.listForUser({ projectId, userId: "usr_founder" })
        ).resolves.toMatchObject([{ groupId: "security-admins", source: "manual" }])
      })
    })

    test("suspends users and revokes active sessions immediately", async () => {
      await withStorage(async (storage) => {
        await createUser(storage)
        await storage.sessions.create({
          id: "ses_1",
          projectId,
          userId: "usr_1",
          strategyId: "magic-link",
          audience: "atlas",
          tokenHash: "hash-1",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-21T10:00:00.000Z"),
        })
        await storage.sessions.create({
          id: "ses_app",
          projectId,
          userId: "usr_1",
          strategyId: "magic-link",
          audience: "app",
          tokenHash: "hash-app",
          createdAt: at("2026-05-14T10:01:00.000Z"),
          expiresAt: at("2026-05-21T10:01:00.000Z"),
        })

        const suspended = await storage.suspendUserAndRevokeSessions({
          projectId,
          userId: "usr_1",
          suspendedAt: at("2026-05-14T10:05:00.000Z"),
        })

        expect(suspended.status).toBe("suspended")
        await expect(storage.sessions.getById({ projectId, id: "ses_1" })).resolves.toMatchObject({
          revokedAt: at("2026-05-14T10:05:00.000Z"),
        })
        await expect(storage.sessions.getById({ projectId, id: "ses_app" })).resolves.toMatchObject(
          {
            revokedAt: at("2026-05-14T10:05:00.000Z"),
          }
        )
      })
    })
  })
}
