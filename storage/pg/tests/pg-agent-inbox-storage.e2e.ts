import { runAgentInboxStorageContractSuite } from "@sixb/core/testing"
import { createTestStorage, disposeTestStorage } from "./helpers"

runAgentInboxStorageContractSuite("PgAgentInboxStore", {
  createStorage: async () => (await createTestStorage()).storage,
  teardown: disposeTestStorage,
})
