import { describe, expect, test } from "bun:test"
import type { CreateSharedAccessSessionInput, ShareSessionStorage } from "../storage/share-sessions"

export interface ShareSessionStorageContractSuiteOptions<
  TStorage extends ShareSessionStorage = ShareSessionStorage,
> {
  /** Factory that returns an isolated shared-session store for each test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "share-session-contract"
const createdAt = new Date("2026-08-20T12:00:00.000Z")
const expiresAt = new Date("2026-08-20T12:15:00.000Z")

/** Runs the provider-neutral shared-session contract against one storage implementation. */
export function runShareSessionStorageContractSuite<TStorage extends ShareSessionStorage>(
  label: string,
  options: ShareSessionStorageContractSuiteOptions<TStorage>
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
        const inputCreatedAt = new Date(createdAt)
        const inputExpiresAt = new Date(expiresAt)
        const created = await storage.create(
          sessionInput({ createdAt: inputCreatedAt, expiresAt: inputExpiresAt })
        )

        inputCreatedAt.setUTCFullYear(2040)
        inputExpiresAt.setUTCFullYear(2040)
        created.createdAt.setUTCFullYear(2041)

        await expect(storage.get({ projectId, sessionId: "shs_1" })).resolves.toEqual(
          sessionInput()
        )
      })
    })

    test("isolates projects and scopes uniqueness to one project", async () => {
      await withStorage(async (storage) => {
        await storage.create(sessionInput())
        await storage.create(sessionInput({ projectId: "other-project" }))

        await expect(
          storage.get({ projectId: "other-project", sessionId: "shs_1" })
        ).resolves.toMatchObject({ projectId: "other-project" })
        await expect(
          storage.create(sessionInput({ tokenDigest: "another-digest" }))
        ).rejects.toEqual(expect.objectContaining({ code: "duplicate" }))
        await expect(
          storage.create(sessionInput({ id: "shs_2", tokenDigest: "digest-1" }))
        ).rejects.toEqual(expect.objectContaining({ code: "duplicate" }))
      })
    })

    test("rejects invalid records consistently", async () => {
      await withStorage(async (storage) => {
        const invalidInputs: CreateSharedAccessSessionInput[] = [
          sessionInput({ id: "" }),
          sessionInput({ projectId: "" }),
          sessionInput({ grantId: "" }),
          sessionInput({ tokenDigest: "" }),
          sessionInput({ expiresAt: new Date(createdAt) }),
          sessionInput({ createdAt: new Date("invalid") }),
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
        await storage.create(sessionInput())
        await expect(
          storage.create(sessionInput({ expiresAt: new Date(createdAt) }))
        ).rejects.toEqual(expect.objectContaining({ code: "invalid" }))
      })
    })

    test("keeps the first concurrent revocation and remains idempotent", async () => {
      await withStorage(async (storage) => {
        await storage.create(sessionInput())
        const left = {
          projectId,
          sessionId: "shs_1",
          revokedAt: new Date("2026-08-20T12:05:00.000Z"),
        }
        const right = {
          projectId,
          sessionId: "shs_1",
          revokedAt: new Date("2026-08-20T12:06:00.000Z"),
        }

        const [firstResult, secondResult] = await Promise.all([
          storage.revoke(left),
          storage.revoke(right),
        ])
        expect(firstResult).toEqual(secondResult)

        const stored = await storage.get({ projectId, sessionId: "shs_1" })
        expect(
          [left.revokedAt.toISOString(), right.revokedAt.toISOString()].includes(
            stored?.revokedAt?.toISOString() ?? ""
          )
        ).toBe(true)
        await expect(
          storage.revoke({
            projectId,
            sessionId: "shs_1",
            revokedAt: new Date("2026-08-20T12:07:00.000Z"),
          })
        ).resolves.toEqual(stored)
      })
    })

    test("rejects revocation timestamps before session creation", async () => {
      await withStorage(async (storage) => {
        await storage.create(sessionInput())
        await expect(
          storage.revoke({
            projectId,
            sessionId: "shs_1",
            revokedAt: new Date("2026-08-20T11:59:59.999Z"),
          })
        ).rejects.toEqual(expect.objectContaining({ code: "invalid" }))
      })
    })
  })
}

function sessionInput(
  overrides: Partial<CreateSharedAccessSessionInput> = {}
): CreateSharedAccessSessionInput {
  return {
    id: "shs_1",
    projectId,
    grantId: "shr_1",
    tokenDigest: "digest-1",
    createdAt: new Date(createdAt),
    expiresAt: new Date(expiresAt),
    ...overrides,
  }
}
