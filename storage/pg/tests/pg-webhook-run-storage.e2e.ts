import { runWebhookRunStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

const contractStorageOwners = new WeakMap<PostgresStorage["webhookRuns"], PostgresStorage>()

runWebhookRunStorageContractSuite("PgWebhookRunStorage contract", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    contractStorageOwners.set(storage.webhookRuns, storage)
    return storage.webhookRuns
  },
  cleanup: async (webhookRuns) => {
    const owner = contractStorageOwners.get(webhookRuns)
    if (!owner) return
    await owner.dropSchema()
    await owner.close()
  },
})
