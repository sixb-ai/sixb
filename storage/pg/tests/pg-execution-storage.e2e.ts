import { runExecutionStorageContractSuite } from "@sixb/core/testing"
import { createTestStorage, disposeTestStorage } from "./helpers"

runExecutionStorageContractSuite("PostgresStorage execution ledger", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: disposeTestStorage,
})
