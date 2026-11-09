import { runArtifactHoldersContractSuite } from "@sixb/core/testing"
import { createTestStorage, disposeTestStorage } from "./helpers"

runArtifactHoldersContractSuite("PostgreSQL artifact holders", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: (storage) => disposeTestStorage(storage),
})
