import { runEffectiveStorageContractSuite } from "@sixb/core/testing"
import { createTestStorage, disposeTestStorage } from "./helpers"

runEffectiveStorageContractSuite("PostgresStorage", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: disposeTestStorage,
})
