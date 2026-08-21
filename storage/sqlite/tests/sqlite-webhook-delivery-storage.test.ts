import { runWebhookDeliveryStorageContractSuite } from "@sixb/core/testing"
import { SqliteWebhookDeliveryStorage } from "../src/webhook-delivery-storage"

runWebhookDeliveryStorageContractSuite("SqliteWebhookDeliveryStorage", {
  createStorage: () => new SqliteWebhookDeliveryStorage(),
  cleanup(storage) {
    storage.close()
  },
})
