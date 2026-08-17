import { runWebhookRunStorageContractSuite } from "@sixb/core/testing"
import { createTestStorage } from "./helpers"

runWebhookRunStorageContractSuite("PostgresStorage Webhook runs", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: async (storage) => {
    await storage.dropSchema()
    await storage.close()
  },
})
