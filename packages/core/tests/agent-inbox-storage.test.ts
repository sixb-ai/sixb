import { InMemoryStorage } from "../src"
import { runAgentInboxStorageContractSuite } from "../src/testing"

runAgentInboxStorageContractSuite("InMemoryAgentInboxStore", {
  createStorage: () => new InMemoryStorage(),
})
