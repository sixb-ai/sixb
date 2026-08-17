import { InMemoryStorage } from "@sixb/core"
import { runWebhookRunStorageContractSuite } from "../src/testing"

runWebhookRunStorageContractSuite("InMemoryStorage Webhook runs", {
  createStorage: () => new InMemoryStorage(),
})
