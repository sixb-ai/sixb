import { InMemoryStorage } from "../src/storage"
import { runSnapshotLoadContractSuite, runSnapshotReadContractSuite } from "../src/testing"

runSnapshotReadContractSuite("In-memory storage", {
  createStorage: async () => new InMemoryStorage(),
})

runSnapshotLoadContractSuite("In-memory storage", {
  createStorage: async () => new InMemoryStorage(),
})
