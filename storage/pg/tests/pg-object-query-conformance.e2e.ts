import { runObjectQueryProviderContractSuite } from "@sixb/core/testing"
import { createTestStorage } from "./helpers"

runObjectQueryProviderContractSuite("PostgresStorage object query provider contract", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    return storage
  },
  teardown: async (storage) => {
    await storage.dropSchema()
    await storage.close()
  },
})
