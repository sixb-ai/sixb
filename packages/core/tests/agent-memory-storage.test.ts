import { InMemoryStorage } from "../src"
import { runAgentMemoryStorageContractSuite } from "../src/testing"

runAgentMemoryStorageContractSuite("InMemoryAgentMemoryStore", {
  createStorage: () => new InMemoryStorage(),
})
