import { describe, expect, test } from "bun:test"
import type { ShareSessionStorage } from "@sixb/core/storage"
import {
  createShareGrantStorageContractInput,
  createShareSessionStorageContractInput,
  runShareSessionStorageContractSuite,
} from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

const storages = new Map<ShareSessionStorage, PostgresStorage>()

runShareSessionStorageContractSuite("PgShareSessionStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    await seedGrants(storage)
    storages.set(storage.shareSessions, storage)
    return storage.shareSessions
  },
  cleanup: async (shareSessions) => {
    const storage = storages.get(shareSessions)
    if (!storage) return
    storages.delete(shareSessions)
    await storage.dropSchema()
    await storage.close()
  },
})

describe("Postgres Share session storage integration", () => {
  test("enforces grant references and participates in transactions", async () => {
    const { storage } = await createTestStorage()
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
      await storage.dropSchema()
      await storage.close()
    }
  })
})

async function seedGrants(storage: PostgresStorage): Promise<void> {
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
