import { runPipelineRunReadContractSuite } from "@sixb/core/testing"
import { createTestStorage, disposeTestStorage } from "./helpers"

runPipelineRunReadContractSuite("PostgresStorage", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: disposeTestStorage,
})
