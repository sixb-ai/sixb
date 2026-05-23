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
  audience: CompleteAuthSessionInput["audience"] = "admin"
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
 * The suite is the storage-independent specification for Pario auth state: users, identities,
 * sessions, invitations, group memberships, magic links, OIDC attempts, and atomic sign-in
 * completion.
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

    test("creates one active session per user per audience and never extends expiry on touch", async () => {
      await withStorage(async (storage) => {
        await createUser(storage)

        const first = await storage.sessions.create({
          id: "ses_1",
          projectId,
          userId: "usr_1",
          strategyId: "magic-link",
          audience: "admin",
          tokenHash: "hash-1",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-21T10:00:00.000Z"),
        })
        const second = await storage.sessions.create({
          id: "ses_2",
          projectId,
          userId: "usr_1",
          strategyId: "magic-link",
          audience: "admin",
          tokenHash: "hash-2",
          createdAt: at("2026-05-14T10:05:00.000Z"),
          expiresAt: at("2026-05-21T10:05:00.000Z"),
        })

        expect(first.revokedAt).toBeUndefined()
        await expect(storage.sessions.getById({ projectId, id: "ses_1" })).resolves.toMatchObject({
          revokedAt: at("2026-05-14T10:05:00.000Z"),
        })
        await expect(
          storage.sessions.getActiveByUserId({
            projectId,
            userId: "usr_1",
            audience: "admin",
            now: at("2026-05-14T10:06:00.000Z"),
          })
        ).resolves.toMatchObject({ id: "ses_2" })
        await expect(
          storage.sessions.findValidByTokenHash({
            projectId,
            id: "ses_2",
            audience: "admin",
            tokenHash: "wrong",
            now: at("2026-05-14T10:06:00.000Z"),
          })
        ).resolves.toBeNull()

        const touched = await storage.sessions.touch({
          projectId,
          id: second.id,
          lastSeenAt: at("2026-05-15T10:00:00.000Z"),
        })
        expect(touched.lastSeenAt?.toISOString()).toBe("2026-05-15T10:00:00.000Z")
        expect(touched.expiresAt.toISOString()).toBe("2026-05-21T10:05:00.000Z")

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
        const currentAdminSession = await storage.sessions.getById({ projectId, id: "ses_2" })
        expect(currentAdminSession?.revokedAt).toBeUndefined()
        await expect(
          storage.sessions.findValidByTokenHash({
            projectId,
            id: "ses_app",
            audience: "admin",
            tokenHash: "hash-app",
            now: at("2026-05-14T10:07:00.000Z"),
          })
        ).resolves.toBeNull()
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

    test("creates one active magic link per email and consumes it once", async () => {
      await withStorage(async (storage) => {
        await storage.magicLinks.create({
          id: "ml_1",
          projectId,
          strategyId: "magic-link",
          email: "ava@acme.com",
          tokenHash: "hash-1",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-14T10:15:00.000Z"),
        })
        await storage.magicLinks.create({
          id: "ml_2",
          projectId,
          strategyId: "magic-link",
          email: " ava@acme.com ",
          tokenHash: "hash-2",
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
          audience: "admin",
          tokenHash: "old-hash",
          createdAt: at("2026-05-14T10:00:00.000Z"),
          expiresAt: at("2026-05-21T10:00:00.000Z"),
        })
        await storage.magicLinks.create({
          id: "ml_1",
          projectId,
          strategyId: "magic-link",
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
        await expect(storage.sessions.getById({ projectId, id: "ses_old" })).resolves.toMatchObject(
          {
            revokedAt: at("2026-05-14T10:10:00.000Z"),
          }
        )
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
          audience: "admin",
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
