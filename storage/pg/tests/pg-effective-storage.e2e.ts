import { runEffectiveStorageContractSuite } from "@sixb/core/testing"
import { createTestStorage } from "./helpers"

runEffectiveStorageContractSuite("PostgresStorage", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: async (storage) => {
    await storage.dropSchema()
    await storage.close()
  },
})
