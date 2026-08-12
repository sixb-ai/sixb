import { runExecutionStorageContractSuite } from "@sixb/core/testing"
import { createTestStorage } from "./helpers"

runExecutionStorageContractSuite("PostgresStorage execution ledger", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: async (storage) => {
    await storage.dropSchema()
    await storage.close()
  },
})
