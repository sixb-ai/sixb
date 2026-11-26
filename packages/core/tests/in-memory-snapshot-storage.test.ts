import { InMemoryStorage } from "../src/storage"
import { runSnapshotReadContractSuite } from "../src/testing"

runSnapshotReadContractSuite("In-memory storage", {
  createStorage: async () => new InMemoryStorage(),
})
