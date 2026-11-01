import { InMemoryAgentStorage } from "../src/storage/agents"
import { InMemoryAuthStorage } from "../src/storage/auth"
import { InMemoryExecutionStorage } from "../src/storage/executions/in-memory"
import { runAgentTokenRateStorageContractSuite } from "../src/testing"

runAgentTokenRateStorageContractSuite("InMemoryAgentTokenRateStore", {
  createStorage: () => ({
    agents: new InMemoryAgentStorage(new InMemoryExecutionStorage(new InMemoryAuthStorage())),
  }),
  countStored: async (storage) => storage.agents.snapshot().tokenRates.size,
})
