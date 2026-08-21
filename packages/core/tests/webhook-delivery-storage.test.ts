import { InMemoryWebhookDeliveryStorage } from "../src/storage"
import { runWebhookDeliveryStorageContractSuite } from "../src/testing"

runWebhookDeliveryStorageContractSuite("InMemoryWebhookDeliveryStorage", {
  createStorage: () => new InMemoryWebhookDeliveryStorage(),
})
