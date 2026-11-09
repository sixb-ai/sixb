import type { MaintenanceHeartbeatStorage } from "@sixb/core/storage"
import { runMaintenanceHeartbeatStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

const storages = new Map<MaintenanceHeartbeatStorage, SqliteStorage>()

runMaintenanceHeartbeatStorageContractSuite("SqliteMaintenanceHeartbeatStorage", {
  createStorage: () => {
    const storage = new SqliteStorage()
    storages.set(storage.maintenanceHeartbeats, storage)
    return storage.maintenanceHeartbeats
  },
  cleanup: (heartbeats) => {
    storages.get(heartbeats)?.close()
    storages.delete(heartbeats)
  },
})
