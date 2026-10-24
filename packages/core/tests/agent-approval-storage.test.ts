import { InMemoryStorage } from "../src"
import { runAgentApprovalStorageContractSuite } from "../src/testing"

runAgentApprovalStorageContractSuite("InMemoryAgentApprovalStore", {
  createStorage: () => new InMemoryStorage(),
})
