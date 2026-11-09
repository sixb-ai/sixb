import { InMemoryMaintenanceHeartbeatStorage } from "../src/storage/maintenance-heartbeats"
import { runMaintenanceHeartbeatStorageContractSuite } from "../src/testing"

runMaintenanceHeartbeatStorageContractSuite("InMemoryMaintenanceHeartbeatStorage", {
  createStorage: () => new InMemoryMaintenanceHeartbeatStorage(),
})
