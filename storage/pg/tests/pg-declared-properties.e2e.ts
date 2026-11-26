import { runDeclaredPropertiesContractSuite } from "@sixb/core/testing"
import { createTestStorage, disposeTestStorage } from "./helpers"

runDeclaredPropertiesContractSuite("PostgreSQL storage", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: (storage) => disposeTestStorage(storage),
})
