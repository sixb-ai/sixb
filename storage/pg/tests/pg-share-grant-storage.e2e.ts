import { describe, expect, test } from "bun:test"
import type { ShareGrantStorage } from "@sixb/core/storage"
import {
  createShareGrantStorageContractInput,
  runShareGrantStorageContractSuite,
} from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

const storages = new Map<ShareGrantStorage, PostgresStorage>()

runShareGrantStorageContractSuite("PgShareGrantStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    storages.set(storage.shareGrants, storage)
    return storage.shareGrants
  },
  cleanup: async (shareGrants) => {
    const storage = storages.get(shareGrants)
    if (!storage) return
    storages.delete(shareGrants)
    await storage.dropSchema()
    await storage.close()
  },
})

describe("Postgres Share grant storage integration", () => {
  test("participates in storage transactions and rolls back atomically", async () => {
    const { storage } = await createTestStorage()
    try {
      await storage.transaction(async (tx) => {
        await tx.shareGrants?.create(createShareGrantStorageContractInput())
      })
      await expect(
        storage.shareGrants.getById({ projectId: "share-grant-contract", id: "shr_1" })
      ).resolves.toMatchObject({ id: "shr_1" })

      await expect(
        storage.transaction(async (tx) => {
          await tx.shareGrants?.create(
            createShareGrantStorageContractInput({
              id: "shr_rollback",
              tokenHash: "b".repeat(64),
            })
          )
          throw new Error("rollback")
        })
      ).rejects.toThrow("rollback")
      await expect(
        storage.shareGrants.getById({
          projectId: "share-grant-contract",
          id: "shr_rollback",
        })
      ).resolves.toBeNull()
    } finally {
      await storage.dropSchema()
      await storage.close()
    }
  })
})
