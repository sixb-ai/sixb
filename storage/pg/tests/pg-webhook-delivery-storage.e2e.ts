import { runWebhookDeliveryStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

const contractStorageOwners = new WeakMap<PostgresStorage["webhookDeliveries"], PostgresStorage>()

runWebhookDeliveryStorageContractSuite("PgWebhookDeliveryStorage contract", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    contractStorageOwners.set(storage.webhookDeliveries, storage)
    return storage.webhookDeliveries
  },
  cleanup: async (webhookDeliveries) => {
    const owner = contractStorageOwners.get(webhookDeliveries)
    if (!owner) return
    await owner.dropSchema()
    await owner.close()
  },
})
