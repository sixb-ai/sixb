import { runWebhookRunStorageContractSuite } from "@sixb/core/testing"
import { createTestStorage, disposeTestStorage } from "./helpers"

runWebhookRunStorageContractSuite("PostgresStorage Webhook runs", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: disposeTestStorage,
})
