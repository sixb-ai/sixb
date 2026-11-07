import { runRunClaimStorageContractSuite } from "@sixb/core/testing"
import { createTestStorage, disposeTestStorage } from "./helpers"

runRunClaimStorageContractSuite("PostgresStorage run claims", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: disposeTestStorage,
})
