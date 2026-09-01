import { runAiLimitStorageContractSuite } from "@sixb/core/testing"
import { createTestStorage } from "./helpers"

runAiLimitStorageContractSuite("PgAiLimitStorage", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: async (storage) => {
    await storage.dropSchema()
    await storage.close()
  },
})
