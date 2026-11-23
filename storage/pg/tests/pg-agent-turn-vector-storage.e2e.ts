import { runAgentTurnVectorStorageContractSuite } from "@sixb/core/testing"
import { createTestStorage, disposeTestStorage } from "./helpers"

runAgentTurnVectorStorageContractSuite("PgAgentTurnVectorStore", {
  createStorage: async () => (await createTestStorage()).storage,
  teardown: disposeTestStorage,
})
