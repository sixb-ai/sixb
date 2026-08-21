import { InMemoryWebhookRunStorage } from "../src/storage"
import { runWebhookRunStorageContractSuite } from "../src/testing"

runWebhookRunStorageContractSuite("InMemoryWebhookRunStorage", {
  createStorage: () => new InMemoryWebhookRunStorage(),
})
