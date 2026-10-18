import { runAiLimitStorageContractSuite } from "@sixb/core/testing"
import { createTestStorage, disposeTestStorage } from "./helpers"

runAiLimitStorageContractSuite("PgAiLimitStorage", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: disposeTestStorage,
})
