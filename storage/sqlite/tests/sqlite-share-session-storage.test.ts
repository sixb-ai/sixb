import { describe, expect, test } from "bun:test"
import type { ShareSessionStorage } from "@sixb/core/storage"
import {
  createShareGrantStorageContractInput,
  createShareSessionStorageContractInput,
  runShareSessionStorageContractSuite,
} from "@sixb/core/testing"
import { SqliteStorage } from "../src"

const storages = new Map<ShareSessionStorage, SqliteStorage>()

runShareSessionStorageContractSuite("SqliteShareSessionStorage", {
  createStorage: async () => {
    const storage = new SqliteStorage()
    await seedGrants(storage)
    storages.set(storage.shareSessions, storage)
    return storage.shareSessions
  },
  cleanup: (shareSessions) => {
    const storage = storages.get(shareSessions)
    if (!storage) return
    storages.delete(shareSessions)
    storage.close()
  },
})

describe("SqliteStorage Share session integration", () => {
  test("enforces grant references and participates in transactions", async () => {
    const storage = new SqliteStorage()
    try {
      await expect(
        storage.shareSessions.create(createShareSessionStorageContractInput())
      ).rejects.toMatchObject({ code: "invalid_input" })
      await seedGrants(storage)
      await storage.transaction(async (tx) => {
        await tx.shareSessions?.create(createShareSessionStorageContractInput())
      })
      await expect(
        storage.shareSessions.getById({ projectId: "share-session-contract", id: "shs_1" })
      ).resolves.toMatchObject({ grantId: "shr_1" })

      await expect(
        storage.transaction(async (tx) => {
          await tx.shareSessions?.create(
            createShareSessionStorageContractInput({
              id: "shs_rollback",
              tokenHash: "b".repeat(64),
            })
          )
          throw new Error("rollback")
        })
      ).rejects.toThrow("rollback")
      await expect(
        storage.shareSessions.getById({
          projectId: "share-session-contract",
          id: "shs_rollback",
        })
      ).resolves.toBeNull()
    } finally {
      storage.close()
    }
  })
})

async function seedGrants(storage: SqliteStorage): Promise<void> {
  const expiresAt = new Date("2026-08-21T12:00:00.000Z")
  await storage.shareGrants.create(
    createShareGrantStorageContractInput({
      projectId: "share-session-contract",
      id: "shr_1",
      expiresAt,
    })
  )
  await storage.shareGrants.create(
    createShareGrantStorageContractInput({
      projectId: "other-project",
      id: "shr_1",
      expiresAt,
    })
  )
}
