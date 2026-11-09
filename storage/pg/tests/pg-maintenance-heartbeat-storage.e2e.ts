import type { MaintenanceHeartbeatStorage } from "@sixb/core/storage"
import { runMaintenanceHeartbeatStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage, disposeTestStorage } from "./helpers"

const storages = new Map<MaintenanceHeartbeatStorage, PostgresStorage>()

runMaintenanceHeartbeatStorageContractSuite("PgMaintenanceHeartbeatStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    storages.set(storage.maintenanceHeartbeats, storage)
    return storage.maintenanceHeartbeats
  },
  cleanup: async (heartbeats) => {
    const storage = storages.get(heartbeats)
    if (!storage) return
    storages.delete(heartbeats)
    await disposeTestStorage(storage)
  },
})
