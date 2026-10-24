import { runAgentApprovalStorageContractSuite } from "@sixb/core/testing"
import { createTestStorage, disposeTestStorage } from "./helpers"

runAgentApprovalStorageContractSuite("PgAgentApprovalStore", {
  createStorage: async () => (await createTestStorage()).storage,
  teardown: disposeTestStorage,
})
