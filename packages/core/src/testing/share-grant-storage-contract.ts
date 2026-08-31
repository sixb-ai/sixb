import { describe, expect, test } from "bun:test"
import type { CreateShareGrantInput, ShareGrantStorage } from "../storage/share-grants"

export interface ShareGrantStorageContractSuiteOptions<
  TStorage extends ShareGrantStorage = ShareGrantStorage,
> {
  /** Returns an isolated provider capability for every test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "share-grant-contract"
const createdAt = new Date("2026-08-19T12:00:00.000Z")
const expiresAt = new Date("2026-08-20T12:00:00.000Z")

/** Provider-neutral lifecycle and isolation contract for durable Share grants. */
export function runShareGrantStorageContractSuite<TStorage extends ShareGrantStorage>(
  label: string,
  options: ShareGrantStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (run: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await run(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    test("stores derived authority and returns defensive copies", async () => {
      await withStorage(async (storage) => {
        const input = grantInput()
        const created = await storage.create(input)

        ;(input.target as { primaryId: string }).primaryId = "mutated-input"
        ;(input.issuedBy as { id: string }).id = "mutated-input"
        input.createdAt.setUTCFullYear(2040)
        attemptMutation(() => {
          ;(created.target as { primaryId: string }).primaryId = "mutated-result"
        })
        created.createdAt.setUTCFullYear(2041)
        const viewGrant = created.authoritySnapshot.access.grants[0]
        if (!viewGrant || viewGrant.kind !== "object.view") {
          throw new Error("Share grant storage fixture must contain an object.view grant.")
        }
        attemptMutation(() => {
          ;(viewGrant.selection.roots[0]!.anchor as { primaryId: string }).primaryId =
            "mutated-result"
        })

        const stored = await storage.getById({ projectId, id: "shr_1" })
        expect(stored).toMatchObject({
          id: "shr_1",
          target: { objectTypeId: "Report", primaryId: "report-1" },
          issuedBy: { type: "user", id: "usr_1" },
          authoritySnapshot: { version: 1 },
          destinationPath: "/reports/report-1",
          createdAt,
          expiresAt,
        })
        expect(stored?.authorityDigest).toMatch(/^[0-9a-f]{64}$/)
        expect(stored?.tokenHash).toBe("a".repeat(64))
      })
    })

    test("enforces id and token-hash uniqueness per project", async () => {
      await withStorage(async (storage) => {
        await storage.create(grantInput())
        await expect(
          storage.create(grantInput({ tokenHash: "b".repeat(64) }))
        ).rejects.toMatchObject({ code: "duplicate" })
        await expect(storage.create(grantInput({ id: "shr_2" }))).rejects.toMatchObject({
          code: "duplicate",
        })

        await expect(
          storage.create(grantInput({ projectId: "other-project" }))
        ).resolves.toMatchObject({ id: "shr_1", projectId: "other-project" })
      })
    })

    test("lists a bounded deterministic page with total and hasMore", async () => {
      await withStorage(async (storage) => {
        await storage.create(grantInput({ id: "shr_a", tokenHash: "b".repeat(64) }))
        await storage.create(grantInput({ id: "shr_z", tokenHash: "c".repeat(64) }))
        await storage.create(
          grantInput({
            id: "shr_newer",
            tokenHash: "d".repeat(64),
            createdAt: new Date("2026-08-19T13:00:00.000Z"),
          })
        )

        await expect(
          storage.list({ projectId, now: createdAt, limit: 2, offset: 0 })
        ).resolves.toMatchObject({
          grants: [{ id: "shr_newer" }, { id: "shr_z" }],
          total: 3,
          hasMore: true,
        })
        await expect(
          storage.list({ projectId, now: createdAt, limit: 2, offset: 2 })
        ).resolves.toMatchObject({
          grants: [{ id: "shr_a" }],
          total: 3,
          hasMore: false,
        })
      })
    })

    test("filters by project, definition, target, expiry, and revocation", async () => {
      await withStorage(async (storage) => {
        await storage.create(grantInput({ id: "active", tokenHash: "b".repeat(64) }))
        await storage.create(
          grantInput({
            id: "other-target",
            tokenHash: "c".repeat(64),
            targetPrimaryId: "report-2",
            destinationPath: "/reports/report-2",
          })
        )
        await storage.create(
          grantInput({ id: "other-definition", tokenHash: "d".repeat(64), definitionId: "other" })
        )
        await storage.create(
          grantInput({
            id: "expired",
            tokenHash: "e".repeat(64),
            expiresAt: new Date("2026-08-19T12:30:00.000Z"),
          })
        )
        await storage.create(grantInput({ id: "revoked", tokenHash: "f".repeat(64) }))
        await storage.revoke({
          projectId,
          id: "revoked",
          revokedAt: new Date("2026-08-19T12:15:00.000Z"),
          revokedBy: { type: "user", id: "usr_revoker" },
        })
        await storage.create(grantInput({ projectId: "other-project" }))

        const filter = {
          projectId,
          definitionId: "published-report",
          target: { objectTypeId: "Report", primaryId: "report-1" },
          now: new Date("2026-08-19T13:00:00.000Z"),
        }
        await expect(storage.list(filter)).resolves.toMatchObject({
          grants: [{ id: "active" }],
          total: 1,
          hasMore: false,
        })
        const allStates = await storage.list({
          ...filter,
          includeExpired: true,
          includeRevoked: true,
        })
        expect(allStates.grants.map((grant) => grant.id)).toEqual(["revoked", "expired", "active"])
      })
    })

    test("treats the exact expiry instant as inactive", async () => {
      await withStorage(async (storage) => {
        await storage.create(grantInput())
        await expect(storage.list({ projectId, now: expiresAt })).resolves.toMatchObject({
          grants: [],
          total: 0,
        })
        await expect(
          storage.list({ projectId, now: expiresAt, includeExpired: true })
        ).resolves.toMatchObject({ grants: [{ id: "shr_1" }], total: 1 })
      })
    })

    test("keeps the first concurrent revocation and makes later calls idempotent", async () => {
      await withStorage(async (storage) => {
        await storage.create(grantInput())
        const left = {
          projectId,
          id: "shr_1",
          revokedAt: new Date("2026-08-19T13:00:00.000Z"),
          revokedBy: { type: "user" as const, id: "usr_left" },
        }
        const right = {
          projectId,
          id: "shr_1",
          revokedAt: new Date("2026-08-19T14:00:00.000Z"),
          revokedBy: { type: "system" as const, id: "system" },
        }

        const [first, second] = await Promise.all([storage.revoke(left), storage.revoke(right)])
        expect(first).toEqual(second)
        expect(
          await storage.revoke({ ...right, revokedAt: new Date("2026-08-19T15:00:00.000Z") })
        ).toEqual(first)
        await expect(storage.revoke({ ...left, id: "missing" })).resolves.toBeNull()
      })
    })

    test("rejects invalid records and list windows consistently", async () => {
      await withStorage(async (storage) => {
        const foreignAuthority = grantInput().authoritySnapshot
        const foreignViewGrant = foreignAuthority.access.grants[0]
        if (!foreignViewGrant || foreignViewGrant.kind !== "object.view") {
          throw new Error("Share grant storage fixture must contain an object.view grant.")
        }
        ;(foreignViewGrant.selection.roots[0]!.anchor as { primaryId: string }).primaryId = "other"

        const invalid: CreateShareGrantInput[] = [
          grantInput({ projectId: "" }),
          grantInput({ tokenHash: "not-a-hash" }),
          grantInput({ destinationPath: "https://example.com/report" }),
          grantInput({ destinationPath: "/reports//report-1" }),
          grantInput({ destinationPath: "/reports?id=1" }),
          grantInput({ expiresAt: new Date(createdAt) }),
          grantInput({ createdAt: new Date("invalid") }),
          grantInput({ issuedBy: { type: "system", id: "system" } as never }),
          grantInput({ authoritySnapshot: foreignAuthority }),
        ]
        for (const input of invalid) {
          await expect(storage.create(input)).rejects.toMatchObject({ code: "invalid_input" })
        }
        await expect(storage.create(null as never)).rejects.toMatchObject({
          code: "invalid_input",
        })
        await expect(storage.getById(null as never)).rejects.toMatchObject({
          code: "invalid_input",
        })

        await expect(storage.list({ projectId, now: createdAt, limit: 201 })).rejects.toMatchObject(
          { code: "invalid_input" }
        )
        await expect(storage.list({ projectId, now: new Date("invalid") })).rejects.toMatchObject({
          code: "invalid_input",
        })
      })
    })

    test("rejects a revocation before creation without changing the grant", async () => {
      await withStorage(async (storage) => {
        await storage.create(grantInput())
        await expect(
          storage.revoke({
            projectId,
            id: "shr_1",
            revokedAt: new Date("2026-08-19T11:59:59.999Z"),
            revokedBy: { type: "user", id: "usr_1" },
          })
        ).rejects.toMatchObject({ code: "invalid_input" })
        const unchanged = await storage.getById({ projectId, id: "shr_1" })
        expect(unchanged).not.toBeNull()
        expect(unchanged).not.toHaveProperty("revokedAt")
        expect(unchanged).not.toHaveProperty("revokedBy")
      })
    })
  })
}

function grantInput(
  overrides: Partial<CreateShareGrantInput> & { readonly targetPrimaryId?: string } = {}
): CreateShareGrantInput {
  const targetPrimaryId = overrides.targetPrimaryId ?? "report-1"
  const target = overrides.target ?? { objectTypeId: "Report", primaryId: targetPrimaryId }
  const base: CreateShareGrantInput = {
    id: "shr_1",
    projectId,
    definitionId: "published-report",
    target,
    issuedBy: { type: "user", id: "usr_1" },
    authoritySnapshot: authoritySnapshot(target.objectTypeId, target.primaryId),
    tokenHash: "a".repeat(64),
    destinationPath: "/reports/report-1",
    createdAt: new Date(createdAt),
    expiresAt: new Date(expiresAt),
  }
  const { targetPrimaryId: _targetPrimaryId, ...recordOverrides } = overrides
  return { ...base, ...recordOverrides }
}

function authoritySnapshot(
  objectTypeId: string,
  primaryId: string
): CreateShareGrantInput["authoritySnapshot"] {
  return {
    version: 1,
    access: {
      grants: [
        {
          kind: "object.view",
          selection: {
            kind: "selected",
            roots: [
              {
                anchor: { objectTypeId, primaryId },
                node: {
                  objects: [{ objectTypeId, propertyIds: ["id", "title"] }],
                  links: [],
                },
              },
            ],
          },
        },
      ],
    },
  }
}

export function createShareGrantStorageContractInput(
  overrides: Partial<CreateShareGrantInput> = {}
): CreateShareGrantInput {
  return grantInput(overrides)
}

function attemptMutation(mutate: () => void): void {
  try {
    mutate()
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError)
  }
}
