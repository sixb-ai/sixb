import { describe, expect, test } from "bun:test"
import {
  createShareGrantStorageContractInput,
  runShareGrantStorageContractSuite,
} from "@sixb/core/testing"
import { SqliteStorage } from "../src"
import { SqliteShareGrantStorage } from "../src/share-grant-storage"

runShareGrantStorageContractSuite("SqliteShareGrantStorage", {
  createStorage: () => new SqliteShareGrantStorage(),
  cleanup: (storage) => storage.close(),
})

describe("SqliteStorage Share grant integration", () => {
  test("participates in storage transactions and rolls back atomically", async () => {
    const storage = new SqliteStorage()
    try {
      await storage.transaction(async (tx) => {
        await tx.shareGrants?.create(createShareGrantStorageContractInput())
      })
      await expect(
        storage.shareGrants?.getById({ projectId: "share-grant-contract", id: "shr_1" })
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
        storage.shareGrants?.getById({
          projectId: "share-grant-contract",
          id: "shr_rollback",
        })
      ).resolves.toBeNull()
    } finally {
      storage.close()
    }
  })
})
