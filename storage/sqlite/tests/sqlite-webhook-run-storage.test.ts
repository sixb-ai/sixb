import { runWebhookRunStorageContractSuite } from "@sixb/core/testing"
import { SqliteWebhookRunStorage } from "../src/webhook-run-storage"

runWebhookRunStorageContractSuite("SqliteWebhookRunStorage", {
  createStorage: () => new SqliteWebhookRunStorage(),
  cleanup(storage) {
    storage.close()
  },
})
