import { describe, expect, test } from "bun:test"
import type {
  CreateSharedAccessGrantInput,
  SharedAccessGrantRef,
  ShareGrantStorage,
} from "../storage/share-grants"

export interface ShareGrantStorageContractSuiteOptions<
  TStorage extends ShareGrantStorage = ShareGrantStorage,
> {
  /** Factory that returns an isolated share-grant store for each test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "share-grant-contract"
const createdAt = new Date("2026-08-19T12:00:00.000Z")
const expiresAt = new Date("2026-08-20T12:00:00.000Z")

/** Runs the provider-neutral shared-access grant contract against one storage implementation. */
export function runShareGrantStorageContractSuite<TStorage extends ShareGrantStorage>(
  label: string,
  options: ShareGrantStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await body(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    test("stores normalized records and returns defensive copies", async () => {
      await withStorage(async (storage) => {
        const target = { objectTypeId: "report", primaryId: "report-1" }
        const issuedBy = { type: "user" as const, id: "usr_1" }
        const grants: SharedAccessGrantRef[] = [{ capability: "view", objectTypeId: "report" }]
        const inputCreatedAt = new Date(createdAt)
        const inputExpiresAt = new Date(expiresAt)

        const created = await storage.create(
          grantInput({
            target,
            issuedBy,
            grants,
            createdAt: inputCreatedAt,
            expiresAt: inputExpiresAt,
          })
        )

        target.primaryId = "mutated-input"
        issuedBy.id = "mutated-input"
        grants[0] = { capability: "view", objectTypeId: "other" }
        inputCreatedAt.setUTCFullYear(2040)
        inputExpiresAt.setUTCFullYear(2040)
        created.target.primaryId = "mutated-result"
        created.createdAt.setUTCFullYear(2041)

        await expect(storage.get({ projectId, grantId: "shr_1" })).resolves.toEqual(grantInput())
      })
    })

    test("lists grants in deterministic creation order", async () => {
      await withStorage(async (storage) => {
        await storage.create(grantInput({ id: "z", tokenDigest: "digest-z" }))
        await storage.create(grantInput({ id: "a", tokenDigest: "digest-a" }))
        await storage.create(
          grantInput({
            id: "newer",
            tokenDigest: "digest-newer",
            createdAt: new Date("2026-08-19T13:00:00.000Z"),
          })
        )

        const listed = await storage.list({ projectId, now: createdAt })
        expect(listed.map((grant) => grant.id)).toEqual(["newer", "a", "z"])
      })
    })

    test("isolates projects and scopes uniqueness to one project", async () => {
      await withStorage(async (storage) => {
        await storage.create(grantInput())
        await storage.create(grantInput({ projectId: "other-project" }))

        await expect(storage.list({ projectId, now: createdAt })).resolves.toHaveLength(1)
        await expect(
          storage.list({ projectId: "other-project", now: createdAt })
        ).resolves.toHaveLength(1)

        await expect(storage.create(grantInput({ tokenDigest: "another-digest" }))).rejects.toEqual(
          expect.objectContaining({ code: "duplicate" })
        )
        await expect(
          storage.create(grantInput({ id: "shr_2", tokenDigest: "digest-1" }))
        ).rejects.toEqual(expect.objectContaining({ code: "duplicate" }))
      })
    })

    test("filters by type, target, expiry, and revocation", async () => {
      await withStorage(async (storage) => {
        await storage.create(grantInput({ id: "active", tokenDigest: "digest-active" }))
        await storage.create(
          grantInput({
            id: "other-target",
            tokenDigest: "digest-other-target",
            target: { objectTypeId: "report", primaryId: "report-2" },
          })
        )
        await storage.create(
          grantInput({
            id: "other-type",
            tokenDigest: "digest-other-type",
            shareTypeId: "other-share",
          })
        )
        await storage.create(
          grantInput({
            id: "expired",
            tokenDigest: "digest-expired",
            expiresAt: new Date("2026-08-19T12:30:00.000Z"),
          })
        )
        await storage.create(grantInput({ id: "revoked", tokenDigest: "digest-revoked" }))
        await storage.revoke({
          projectId,
          grantId: "revoked",
          revokedAt: new Date("2026-08-19T12:15:00.000Z"),
          revokedBy: { type: "user", id: "usr_revoker" },
        })

        const filter = {
          projectId,
          shareTypeId: "published-report",
          target: { objectTypeId: "report", primaryId: "report-1" },
          now: new Date("2026-08-19T13:00:00.000Z"),
        }
        await expect(storage.list(filter)).resolves.toMatchObject([{ id: "active" }])
        const allStates = await storage.list({
          ...filter,
          includeExpired: true,
          includeRevoked: true,
        })
        expect(allStates.map((grant) => grant.id)).toEqual(["active", "expired", "revoked"])
      })
    })

    test("rejects invalid records consistently", async () => {
      await withStorage(async (storage) => {
        const invalidInputs: CreateSharedAccessGrantInput[] = [
          grantInput({ projectId: "" }),
          grantInput({ tokenDigest: "" }),
          grantInput({ grants: [] }),
          grantInput({ issuedBy: { type: "system", id: "system" } as never }),
          grantInput({ expiresAt: new Date(createdAt) }),
          grantInput({ createdAt: new Date("invalid") }),
        ]

        for (const input of invalidInputs) {
          await expect(storage.create(input)).rejects.toEqual(
            expect.objectContaining({ code: "invalid" })
          )
        }
      })
    })

    test("validates a record before detecting collisions", async () => {
      await withStorage(async (storage) => {
        await storage.create(grantInput())
        await expect(
          storage.create(grantInput({ expiresAt: new Date(createdAt) }))
        ).rejects.toEqual(expect.objectContaining({ code: "invalid" }))
      })
    })

    test("keeps one concurrent revocation and accepts system attribution", async () => {
      await withStorage(async (storage) => {
        await storage.create(grantInput())
        const left = {
          projectId,
          grantId: "shr_1",
          revokedAt: new Date("2026-08-19T13:00:00.000Z"),
          revokedBy: { type: "user" as const, id: "usr_1" },
        }
        const right = {
          projectId,
          grantId: "shr_1",
          revokedAt: new Date("2026-08-19T14:00:00.000Z"),
          revokedBy: { type: "system" as const, id: "system" },
        }

        const [firstResult, secondResult] = await Promise.all([
          storage.revoke(left),
          storage.revoke(right),
        ])
        expect(firstResult).toEqual(secondResult)

        const stored = await storage.get({ projectId, grantId: "shr_1" })
        expect(
          [
            `${left.revokedAt.toISOString()}:${left.revokedBy.type}:${left.revokedBy.id}`,
            `${right.revokedAt.toISOString()}:${right.revokedBy.type}:${right.revokedBy.id}`,
          ].includes(
            `${stored?.revokedAt?.toISOString()}:${stored?.revokedBy?.type}:${stored?.revokedBy?.id}`
          )
        ).toBe(true)

        await expect(
          storage.revoke({
            projectId,
            grantId: "shr_1",
            revokedAt: new Date("2026-08-19T15:00:00.000Z"),
            revokedBy: { type: "serviceAccount", id: "svc_late" },
          })
        ).resolves.toEqual(stored)
      })
    })

    test("rejects revocation timestamps before grant creation", async () => {
      await withStorage(async (storage) => {
        await storage.create(grantInput())
        await expect(
          storage.revoke({
            projectId,
            grantId: "shr_1",
            revokedAt: new Date("2026-08-19T11:59:59.999Z"),
            revokedBy: { type: "system", id: "system" },
          })
        ).rejects.toEqual(expect.objectContaining({ code: "invalid" }))
      })
    })
  })
}

function grantInput(
  overrides: Partial<CreateSharedAccessGrantInput> = {}
): CreateSharedAccessGrantInput {
  return {
    id: "shr_1",
    projectId,
    shareTypeId: "published-report",
    target: { objectTypeId: "report", primaryId: "report-1" },
    issuedBy: { type: "user", id: "usr_1" },
    grants: [{ capability: "view", objectTypeId: "report" }],
    tokenDigest: "digest-1",
    createdAt: new Date(createdAt),
    expiresAt: new Date(expiresAt),
    ...overrides,
  }
}
