import { runWebhookRunStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runWebhookRunStorageContractSuite("SqliteStorage Webhook runs", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
})
