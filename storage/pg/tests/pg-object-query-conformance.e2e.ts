import { runObjectQueryProviderContractSuite } from "@sixb/core/testing"
import { createTestStorage, disposeTestStorage } from "./helpers"

runObjectQueryProviderContractSuite("PostgresStorage object query provider contract", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    return storage
  },
  teardown: disposeTestStorage,
})
