import type { ShareGrantStorage } from "@sixb/core/storage"
import { runShareGrantStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

const bundles = new Map<ShareGrantStorage, PostgresStorage>()

runShareGrantStorageContractSuite("PgShareGrantStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    bundles.set(storage.shareGrants, storage)
    return storage.shareGrants
  },
  cleanup: async (shareGrants) => {
    const storage = bundles.get(shareGrants)
    if (!storage) return
    bundles.delete(shareGrants)
    await storage.dropSchema()
    await storage.close()
  },
})
