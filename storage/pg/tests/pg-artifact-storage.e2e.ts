import { runArtifactStorageContractSuite } from "@sixb/core/testing"
import { createTestStorage } from "./helpers"

runArtifactStorageContractSuite("PgArtifactStorage", {
  createStorage: async () => (await createTestStorage()).storage,
  teardown: async (storage) => {
    await storage.dropSchema()
    await storage.close()
  },
})
