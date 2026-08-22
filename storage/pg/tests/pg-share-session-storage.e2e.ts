import type { ShareSessionStorage } from "@sixb/core/storage"
import { runShareSessionStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

const bundles = new Map<ShareSessionStorage, PostgresStorage>()

runShareSessionStorageContractSuite("PgShareSessionStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    bundles.set(storage.shareSessions, storage)
    return storage.shareSessions
  },
  cleanup: async (shareSessions) => {
    const storage = bundles.get(shareSessions)
    if (!storage) return
    bundles.delete(shareSessions)
    await storage.dropSchema()
    await storage.close()
  },
})
