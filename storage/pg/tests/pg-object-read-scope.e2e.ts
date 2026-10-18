import { runObjectReadScopeContractSuite } from "@sixb/core/testing"
import { createTestStorage, disposeTestStorage } from "./helpers"

runObjectReadScopeContractSuite("PostgresStorage selected object-read scope contract", {
  createHarness: async () => {
    const { storage } = await createTestStorage()
    return {
      storage,
      objectReadScopeFactory: storage.objects,
    }
  },
  teardown: async ({ storage }) => {
    await disposeTestStorage(storage)
  },
})
